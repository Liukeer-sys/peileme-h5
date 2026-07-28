import type { CSSProperties } from "react";
import { useState } from "react";
import { EquivalentIcon, getGeneratedIconSrc } from "./ResultCard";
import type { CalculationResult } from "../utils/calculate";
import { formatMoney } from "../utils/calculate";

type StickerCardProps = {
  result: CalculationResult;
  equivalentId: string | null;
  onClose: () => void;
};

const getPileStyle = (index: number): CSSProperties => {
  const offsets = [
    { x: 0, y: 0, r: 0 },
    { x: 8, y: 5, r: 3 },
    { x: -7, y: 7, r: -4 },
    { x: 5, y: -6, r: 5 },
    { x: -5, y: -4, r: -3 },
    { x: 11, y: -1, r: 6 }
  ];
  const offset = offsets[index] || offsets[offsets.length - 1];

  return {
    left: `${24 + offset.x}px`,
    top: `${8 + offset.y}px`,
    zIndex: 30 - index,
    transform: `rotate(${offset.r}deg)`
  };
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
};

export default function StickerCard({ result, equivalentId, onClose }: StickerCardProps) {
  const [isSaving, setIsSaving] = useState(false);
  const featuredEquivalent =
    result.equivalents.find((item) => item.id === equivalentId) || result.equivalents[0];
  const equivalentCount = featuredEquivalent ? Math.max(1, Math.round(Number(featuredEquivalent.count) || 1)) : 0;
  const maxVisiblePile = 6;
  const pileCount = featuredEquivalent
    ? Math.min(maxVisiblePile, equivalentCount)
    : 0;

  const saveSticker = async () => {
    if (!featuredEquivalent || isSaving) return;
    setIsSaving(true);
    try {
      const canvas = document.createElement("canvas");
      const width = 900;
      const height = 1100;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "#f7fff5");
      bg.addColorStop(0.48, "#fff6dc");
      bg.addColorStop(1, "#ded4f5");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(255,255,255,0.34)";
      roundRect(ctx, 44, 44, width - 88, height - 88, 68);
      ctx.fill();

      ctx.fillStyle = "#2c2731";
      ctx.textAlign = "center";
      ctx.font = "700 38px 'Microsoft YaHei', sans-serif";
      ctx.fillText("赔了么", width / 2, 122);
      ctx.fillStyle = "#7a6a84";
      ctx.font = "800 36px 'Microsoft YaHei', sans-serif";
      ctx.fillText("你的牛马身份", width / 2, 190);
      ctx.fillStyle = "#2c2731";
      const levelFontSize = result.level.length > 12 ? 50 : result.level.length > 8 ? 60 : 72;
      ctx.font = `900 ${levelFontSize}px 'Microsoft YaHei', sans-serif`;
      ctx.fillText(result.level, width / 2, 280);
      ctx.fillStyle = "#7a6a84";
      ctx.font = "800 38px 'Microsoft YaHei', sans-serif";
      ctx.fillText("身价约等于", width / 2, 365);
      ctx.fillStyle = "#2c2731";
      ctx.font = "900 118px 'Microsoft YaHei', sans-serif";
      ctx.fillText(`${featuredEquivalent.count}${featuredEquivalent.unit}`, width / 2, 485);
      ctx.font = "800 44px 'Microsoft YaHei', sans-serif";
      ctx.fillText(featuredEquivalent.name, width / 2, 560);

      const iconSrc = getGeneratedIconSrc(featuredEquivalent.id);
      if (iconSrc) {
        const image = await loadImage(iconSrc);
        const offsets = [
          { x: 0, y: 0, r: 0 },
          { x: 18, y: 10, r: 4 },
          { x: -16, y: 13, r: -5 },
          { x: 12, y: -13, r: 6 },
          { x: -11, y: -10, r: -4 },
          { x: 22, y: -2, r: 7 }
        ];
        const iconSize = 310;
        const baseX = width / 2 - iconSize / 2;
        const baseY = 610;
        for (let index = pileCount - 1; index >= 0; index -= 1) {
          const offset = offsets[index] || offsets[offsets.length - 1];
          ctx.save();
          ctx.translate(baseX + iconSize / 2 + offset.x, baseY + iconSize / 2 + offset.y);
          ctx.rotate((offset.r * Math.PI) / 180);
          ctx.shadowColor = "rgba(58,48,66,0.24)";
          ctx.shadowBlur = 24;
          ctx.shadowOffsetY = 18;
          ctx.drawImage(image, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
          ctx.restore();
        }
        if (equivalentCount > maxVisiblePile) {
          ctx.fillStyle = "rgba(47,41,54,0.88)";
          roundRect(ctx, 596, 836, 120, 62, 31);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.font = "900 32px 'Microsoft YaHei', sans-serif";
          ctx.fillText(`×${featuredEquivalent.count}`, 656, 878);
        }
      }

      const link = document.createElement("a");
      link.download = `赔了么-${result.level}-身份贴纸.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="sticker-overlay" role="dialog" aria-modal="true">
      <div className="sticker-modal">
        <div className="sticker-card">
          <button className="icon-button close" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
          <div className="sticker-title">赔了么</div>
          <div className="sticker-kicker">你的牛马身份</div>
          <div className="sticker-main">{result.level}</div>
          {featuredEquivalent ? (
            <div className="sticker-equivalent">
              <span>身价约等于</span>
              <strong>
                {featuredEquivalent.count}
                {featuredEquivalent.unit}
              </strong>
              <b>{featuredEquivalent.name}</b>
              <div className="sticker-icon-pile" aria-hidden="true">
                {Array.from({ length: pileCount }).map((_, index) => (
                  <div className="sticker-pile-item" style={getPileStyle(index)} key={index}>
                    <EquivalentIcon
                      id={featuredEquivalent.id}
                      category={featuredEquivalent.category}
                      name={featuredEquivalent.name}
                    />
                  </div>
                ))}
                {equivalentCount > maxVisiblePile && <em>×{featuredEquivalent.count}</em>}
              </div>
            </div>
          ) : (
            <div className="sticker-money">
              {formatMoney(result.lowAmount)}
              <span>起</span>
            </div>
          )}
        </div>
        <div className="sticker-actions">
          <button className="save-sticker-button" type="button" onClick={saveSticker} disabled={isSaving}>
            {isSaving ? "正在生成图片" : "保存图片发朋友圈/状态"}
          </button>
          <p>保存成战绩贴纸，朋友圈、微信状态、小红书或抖音都能发。</p>
        </div>
      </div>
    </div>
  );
}

