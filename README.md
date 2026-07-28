# 赔了么 H5 Demo

一个移动端优先的「牛马身价 / 离职赔偿预评估」对话式产品 demo。

## 本地启动

```bash
npm install
npm run dev
```

默认访问：

```bash
http://localhost:5173
```

## 构建检查

```bash
npm run build
```

## 目录结构

```text
src/
  App.tsx
  components/
    ChatBubble.tsx
    OptionButtons.tsx
    PaidUpsellCard.tsx
    ResultCard.tsx
    StickerCard.tsx
  data/
    questions.ts
    terminationTypes.ts
  utils/
    calculate.ts
    storage.ts
  styles.css
```

## Demo 边界

页面内已明确展示：

> 本结果仅为离职赔偿预评估，不构成正式法律意见。具体金额和风险需结合材料进一步判断。

当前版本只做前端 state 和 localStorage 保存，不包含后端、支付和真实材料识别。
