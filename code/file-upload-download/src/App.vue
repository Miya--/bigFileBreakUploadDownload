<template>
  <div id="app">
    <div>
      <input type="file" :disabled="status !== Status.wait" @change="handleFileChange" />
      <el-button @click="btnClickHandleUpload" :disabled="uploadDisabled">上传</el-button>
      <el-button @click="btnClickHandleResume" v-if="status === Status.pause">恢复</el-button>
      <el-button
        v-else
        :disabled="status !== Status.uploading || !container.hash"
        @click="btnClickHandlePause"
      >暂停</el-button>

      <el-button @click="clearFile">清空服务端文件</el-button>
    </div>
    <div>
      <div>计算文件 hash</div>
      <div>所用时长(秒): {{calculateHashTime}}</div>
      <el-progress :percentage="hashPercentage"></el-progress>
      <div>总进度</div>
      <el-progress :percentage="fakeUploadPercentage"></el-progress>
    </div>
    <el-table :data="data">
      <el-table-column prop="hash" label="切片hash" align="center"></el-table-column>
      <el-table-column label="大小(KB)" align="center" width="120">
        <template v-slot="{ row }">{{ row.size | transformByte }}</template>
      </el-table-column>
      <el-table-column label="进度" align="center">
        <template v-slot="{ row }">
          <el-progress :percentage="row.percentage" color="#909399"></el-progress>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script>
const SIZE = 10 * 1024 * 1024; // 切片大小
const HOST = "http://127.0.0.1:6060"; // 服务端IP
const Status = {
  wait: "wait",
  pause: "pause",
  uploading: "uploading"
};
export default {
  name: "app",
  filters: {
    transformByte(val) {
      return Number((val / 1024).toFixed(0));
    }
  },
  data: () => ({
    Status,
    container: {
      file: null,
      hash: "",
      worker: null
    },
    // 计算文件hash所用时长 单位:秒
    calculateHashTime: "0",
    hashPercentage: 0,
    data: [],
    requestList: [],
    status: Status.wait,
    // 当暂停时会取消 xhr 导致进度条后退
    // 为了避免这种情况，需要定义一个假的进度条
    fakeUploadPercentage: 0
  }),
  computed: {
    uploadDisabled() {
      return (
        !this.container.file ||
        [Status.pause, Status.uploading].includes(this.status)
      );
    },
    uploadPercentage() {
      if (!this.container.file || !this.data.length) return 0;
      const loaded = this.data
        .map(item => item.size * item.percentage)
        .reduce((acc, cur) => acc + cur);
      return parseInt((loaded / this.container.file.size).toFixed(2));
    }
  },
  watch: {
    uploadPercentage(now) {
      if (now > this.fakeUploadPercentage) {
        this.fakeUploadPercentage = now;
      }
    }
  },
  methods: {
    /**
     * 按钮-暂停上传
     */
    btnClickHandlePause() {
      this.status = Status.pause;
      this.resetData();
    },
    resetData() {
      // requestList 正在上传的切片
      this.requestList.forEach(xhr => xhr?.abort());
      this.requestList = [];
      if (this.container.worker) {
        this.container.worker.onmessage = null;
      }
    },
    /**
     * 按钮-恢复
     */
    async btnClickHandleResume() {
      this.status = Status.uploading;
      const { uploadedList } = await this.verifyUpload(
        this.container.file.name,
        this.container.hash
      );
      await this.uploadChunks(uploadedList);
    },
    // 生成文件切片
    createFileChunk(file, size = SIZE) {
      const fileChunkList = [];
      let cur = 0;
      while (cur < file.size) {
        fileChunkList.push({ file: file.slice(cur, cur + size) });
        cur += size;
      }
      // fileChunkList: [{file: Blob}]
      return fileChunkList;
    },
    // 生成文件 hash（web-worker）
    calculateHash(fileChunkList) {
      return new Promise(resolve => {
        // this.container.worker 是主线程 hash.js中的是子线程
        // 启动一个子线程 计算文件hash
        this.container.worker = new Worker("/hash.js");
        this.container.worker.postMessage({ fileChunkList });
        this.container.worker.onmessage = e => {
          const { percentage, hash } = e.data;
          this.hashPercentage = percentage;
          if (hash) {
            resolve(hash);
          }
        };
      });
    },
    /**
     * 按钮-上传
     */
    handleFileChange(e) {
      const [file] = e.target.files;
      if (!file) return;
      this.resetData();
      Object.assign(this.$data, this.$options.data());
      this.container.file = file;
    },
    /**
     * 按钮-上传
     */
    async btnClickHandleUpload() {
      if (!this.container.file) return;
      this.status = Status.uploading;

      //====== 生成文件切片
      const fileChunkList = this.createFileChunk(this.container.file);
      console.log("文件切片：");
      console.log(fileChunkList);

      //====== 计算大文件hash
      // 计算文件hash前的时间
      let tmpTime = new Date();
      // 开始计算文件hash fileChunkList: [{file: Blob}]
      this.container.hash = await this.calculateHash(fileChunkList);
      // 计算文件hash所用的时长 单位:秒
      this.calculateHashTime = (new Date() - tmpTime) / 1000;
      console.log("整个大文件的hash：" + this.container.hash);

      //====== 校验服务器上是否已存在该大文件
      const tmpRes = JSON.parse(
        await this.verifyUpload(this.container.file.name, this.container.hash)
      );

      const shouldUpload = tmpRes.data.shouldUpload;
      const uploadedList = tmpRes.data.uploadedList;
      if (shouldUpload === "0") {
        this.$message.success("秒传：上传成功");
        this.status = Status.wait;
        return;
      }

      //====== 上传切片
      this.data = fileChunkList.map(({ file }, index) => ({
        // 整个文件的hash
        fileHash: this.container.hash,
        // 切片下标
        index,
        // 当前切片的唯一标识
        hash: this.container.hash + "-" + index,
        // 当前切片文件
        chunk: file,
        // 当前切片文件大小
        size: file.size,
        // 上传进度
        percentage: uploadedList.includes(index) ? 100 : 0
      }));
      await this.uploadChunks(uploadedList);
    },
    // 上传切片，同时过滤已上传的切片
    async uploadChunks(uploadedList = []) {
      // 过滤已上传的切片
      const waitUploadList = this.data.filter(
        ({ hash }) => !uploadedList.includes(hash)
      );
      console.log("待上传的list");
      console.log(waitUploadList);
      const requestList = waitUploadList.map(({ chunk, hash, index }) => {
        const formData = new FormData();
        formData.append("chunk", chunk);
        formData.append("hash", hash);
        formData.append("count", this.data.length);
        formData.append("fileName", this.container.file.name);
        formData.append("fileHash", this.container.hash);
        return { formData, index };
      })
      await this.sendRequest(requestList, 4);
      await Promise.all(requestList);
    },
    // 根据 hash 验证文件是否曾经已经被上传过
    // 没有才进行上传
    async verifyUpload(fileName, fileHash) {
      const { data } = await this.request({
        url: HOST + "/getFileStatus",
        headers: {
          "content-type": "application/json",
          requestId: parseInt(Math.random() * 1000000000000)
        },
        data: JSON.stringify({
          fileName,
          fileHash
        })
      });
      return data;
    },
    // 用闭包保存每个 chunk 的进度数据
    createProgressHandler(item) {
      return e => {
        item.percentage = parseInt(String((e.loaded / e.total) * 100));
      };
    },
    // xhr
    request({
      url,
      method = "post",
      data,
      headers = {},
      onProgress = e => e,
      requestList
    }) {
      return new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = onProgress;
        xhr.open(method, url);
        Object.keys(headers).forEach(key =>
          xhr.setRequestHeader(key, headers[key])
        );
        xhr.send(data);
        xhr.onload = e => {
          // 将请求成功的 xhr 从列表中删除
          if (requestList) {
            const xhrIndex = requestList.findIndex(item => item === xhr);
            requestList.splice(xhrIndex, 1);
          }
          resolve({
            data: e.target.response
          });
        };
        // 暴露当前 xhr 给外部
        requestList?.push(xhr);
      });
    },
    async sendRequest(forms, max = 4) {
      return new Promise(resolve => {
        const len = forms.length;
        let idx = 0;
        let counter = 0;
        const start = async () => {
          // 有请求，有通道
          while (idx < len && max > 0) {
            max--; // 占用通道
            console.log(idx, "start");
            const form = forms[idx].formData;
            const index = forms[idx].index;
            idx++;

            this.request({
              url: HOST + "/chunkUpload",
              headers: {
                requestId: parseInt(Math.random() * 1000000000000)
              },
              data: form,
              onProgress: this.createProgressHandler(this.data[index]),
              requestList: this.requestList
            }).then(() => {
              max++; // 释放通道
              counter++;
              if (counter === len) {
                resolve();
                this.$message.success("文件上传成功！");
              } else {
                start();
              }
            });

          }
        };
        start();
      });
    },
    /**
     * 清理服务端文件夹
     */
    async clearFile() {
      const { data } = await this.request({
        url: HOST + "/cleanDir",
        headers: {
          requestId: parseInt(Math.random() * 1000000000000)
        }
      });

      const res = JSON.parse(data);
      if (res.code === "0") {
        this.$message.success("文件夹清理成功！");
      }
    }
  }
};
</script>