/**
 * ui 包会单独做 typecheck，组件源码里的 side-effect CSS 导入也会直接参与解析。
 * 之前只有 web/desktop 各自声明了 *.css，导致 ui 内部引入第三方样式时在本工程里报 TS2882。
 * 这里补上 ui 自己的声明，让类型检查和实际打包器的处理方式保持一致。
 */
declare module "*.css";
