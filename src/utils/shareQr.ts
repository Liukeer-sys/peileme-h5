type QrCode = {
  addData: (data: string) => void;
  make: () => void;
  createDataURL: (cellSize?: number, margin?: number) => string;
};

type QrCodeFactory = (typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H") => QrCode;

let qrFactoryPromise: Promise<QrCodeFactory> | null = null;

const loadQrFactory = () => {
  if (!qrFactoryPromise) {
    const qrModulePath = "/vendor/qrcode.mjs";
    qrFactoryPromise = import(/* @vite-ignore */ qrModulePath).then(
      (module) => module.default as QrCodeFactory
    );
  }
  return qrFactoryPromise;
};

export const getShareUrl = () => {
  const configuredUrl = import.meta.env.VITE_SHARE_URL?.trim();
  return configuredUrl || window.location.href;
};

export const hasConfiguredShareUrl = () => {
  if (import.meta.env.VITE_SHARE_URL?.trim()) return true;
  return !["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
};

export const createQrDataUrl = async (value: string, cellSize = 8) => {
  const qrcode = await loadQrFactory();
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createDataURL(cellSize, cellSize * 2);
};
