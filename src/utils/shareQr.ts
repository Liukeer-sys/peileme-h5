type QrCode = {
  addData: (data: string) => void;
  make: () => void;
  getModuleCount: () => number;
  isDark: (row: number, col: number) => boolean;
};

type QrCodeFactory = (typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H") => QrCode;

let qrFactoryPromise: Promise<QrCodeFactory> | null = null;

const loadQrFactory = () => {
  if (!qrFactoryPromise) {
    const qrModulePath = `${import.meta.env.BASE_URL}vendor/qrcode.mjs`;
    qrFactoryPromise = import(/* @vite-ignore */ qrModulePath).then(
      (module) => module.default as QrCodeFactory
    );
  }
  return qrFactoryPromise;
};

export const getShareUrl = () => {
  const configuredUrl = import.meta.env.VITE_SHARE_URL?.trim();
  if (configuredUrl && configuredUrl !== "https://your-test-site.example.com/") return configuredUrl;
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(window.location.hostname)) return null;
  return new URL(import.meta.env.BASE_URL, window.location.href).href;
};

export const createQrDataUrl = async (value: string, cellSize = 8) => {
  const qrcode = await loadQrFactory();
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();

  const modules = qr.getModuleCount();
  const margin = cellSize * 4;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = modules * cellSize + margin * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法绘制二维码");

  // Keep the light modules transparent so the sticker paper provides their color.
  ctx.fillStyle = "#4a3518";
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (qr.isDark(row, col)) ctx.fillRect(margin + col * cellSize, margin + row * cellSize, cellSize, cellSize);
    }
  }
  return canvas.toDataURL("image/png");
};
