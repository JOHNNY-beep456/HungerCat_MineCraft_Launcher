fn main() {
    // napi-build 负责补齐 Node-API 链接所需的平台参数（Windows 上链接 node.lib 等）。
    napi_build::setup();
}
