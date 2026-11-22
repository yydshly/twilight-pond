# 暮色池塘 · Twilight Pond

基于「暮色池塘」场景卡构建的实时 3D WebGL + Web Audio 自然池塘伴随应用，适合短暂歇息或挂在副屏静静观看。

## 快速启动

```bash
npm install
npm run dev
```

启动后访问 http://127.0.0.1:5173/。生产构建：

```bash
npm run build
```

## 体验与交互说明

- **360° 自由环看与 4 组机位**：鼠标左键拖拽可 360° 环绕池塘，滚轮缩放；点击底部「视角」或按键盘 `1`–`4` 可平滑切换 **岸边 / 栈桥 / 追鸭 / 俯瞰**，静观 8 秒后自动进入缓慢呼吸漂移镜头。
- **点水与呼唤**：轻点水面激起小涟漪，**长按水面**激起更深波纹；点击「呼唤」触发自然延迟回应与短鸭叫。绿头鸭具备巡游、停顿张望、低头点水觅食、侧身理羽、静置打盹与防过度点击的自然习性。
- **天时与细雨**：点击「暮色」可在 **暮色 / 入夜 / 流转（12 分钟金暮 → 蓝调时刻 → 月夜慢循环）** 间切换；点击「细雨」开启像素级同心雨点涟漪、柔化雨丝与林间细雨声。
- **四轨独立调音与副屏模式**：点击「调音」独立调节 **溪流 / 细雨 / 蛙虫 / 鸭叫** 比例；支持 `5 / 15 / 25` 分钟「静歇」柔和计时、全屏、按 `H` 键彻底隐藏 UI 进入纯粹模式，按 `D` 键查看开发状态 HUD；所有偏好自动记忆在 `localStorage`。

## 四大可复用模块

| 模块 | 文件 | 职责 |
| :--- | :--- | :--- |
| PBR 纹理缓存 | `src/modules/PBRTextureCache.ts` | 纹理去重、色彩空间校验、程序化湿泥/树皮/木屋/水面法线/树叶 PBR 兜底与统一释放 |
| 水面与采样 | `src/modules/WaterSystem.ts` + `src/modules/PondShapeSDF.ts` | HalfFloat 实时平面倒影、`144×144` 波纹与 V 形尾流场、解析雨点同心环与 CPU 同步采样；换新池形仅需替换 `PondShapeSDF` |
| 声音生命周期 | `src/modules/AudioLifecycleManager.ts` | 首次手势淡入、切页休眠、四轨独立混音、户外立体声卷积混响、鸭叫冷却与外部/合成双模式 |
| 来源账本 | `src/modules/AttributionLedger.ts` + `public/assets/ledger.json` | 统一记录 CC BY 4.0 / CC BY 3.0 署名、来源与本地修改说明并在页面「账本」中展示 |

## 替换外部 CC BY 素材

当前版本开箱即可离线运行（内置连续放样绿头鸭与程序化自然声景）。准备好外部素材后，放入对应路径并更新 `public/assets/ledger.json` 即可自动无缝加载替换：

- 绿头鸭模型（CC BY 4.0）：`public/assets/models/mallard.glb`
- 夜间蛙虫录音（CC BY 3.0）：`public/assets/audio/frogs_insects.mp3`
- 自然溪流录音：`public/assets/audio/stream.mp3`
- 短鸭叫录音：`public/assets/audio/duck_quack.mp3`
