export type ProductChannel = "main" | "ai";

const configured = import.meta.env.VITE_PRODUCT_CHANNEL;

if (configured !== "main" && configured !== "ai") {
  throw new Error("VITE_PRODUCT_CHANNEL must be main or ai");
}

export const productChannel: ProductChannel = configured;
