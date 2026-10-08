/// <reference types="node" />

// ui 以浏览器环境为主，个别模块（如 logger 的生产判定）会读取 process.env；
// 这里显式引入 node 类型，保证全局声明不随依赖变化而丢失。
