// /public/hash.js
self.importScripts("/spark-md5.min.js"); // 导入脚本

// onmessage 主线程监听并接收子线程发回来的信息
// 生成文件 hash
self.onmessage = e => {
  const { fileChunkList } = e.data;
  const spark = new self.SparkMD5.ArrayBuffer();
  let percentage = 0;
  let count = 0;
  const loadNext = index => {
    const reader = new FileReader();
    reader.readAsArrayBuffer(fileChunkList[index].file);
    reader.onload = e => {
      count++;
      spark.append(e.target.result);
      if (count === fileChunkList.length) {
        // postMessage 向 Worker 发消息
        self.postMessage({
          percentage: 100,
          hash: spark.end()
        });
        // 关闭子线程
        self.close();
      } else {
        percentage += 100 / fileChunkList.length;
        self.postMessage({
          percentage
        });
        // 递归计算下一个切片
        loadNext(count);
      }
    };
  };
  loadNext(0);
};

/*
接口url:  
inerfaceList: [
  {
    url: "verify", // 校验大文件是否已上传接口
    param: {
      "filename": "", // 大文件名称
      "fileHash": "" // 大文件hash
    },
    response: 
    {
      // 是否需要上传 0-否 1-是
      "shouldUpload": 1,
      // 已上传的切片文件名称数组
      "uploadedList": ["04f155dded51322775730a77b78170e4-0", "04f155dded51322775730a77b78170e4-1"]
    }
  },
  {
    url: "handleFormData", // 上传接口
    param: {
      // 切片文件
      "chunk": File, 
       // 切片文件hash
       "hash": "",
       // 大文件名称
      "filename": "",
       // 大文件hash
      "fileHash": ""
    },
    response: {
      "status": "***",
      "msg": "***"
    }
  }
]
*/