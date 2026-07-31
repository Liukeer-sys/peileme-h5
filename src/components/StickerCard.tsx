import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { EquivalentIcon } from "./ResultCard";
import { getEquivalentIconSrc } from "../data/equivalentIconMap";
import type { CalculationResult } from "../utils/calculate";
import { getPersonaPunchline, getPersonaStickerImageSrc } from "../utils/persona";
import { createQrDataUrl, getShareUrl } from "../utils/shareQr";

type StickerCardProps = {
  result: CalculationResult;
  equivalentId: string | null;
  onClose: () => void;
};

const pileOffsets = [
  { x: 0, y: 0, r: 0 },
  { x: 7, y: 4, r: 3 },
  { x: -6, y: 6, r: -4 },
  { x: 5, y: -5, r: 5 },
  { x: -4, y: -3, r: -3 },
  { x: 9, y: -1, r: 6 }
];

const getPileStyle = (index: number): CSSProperties => {
  const offset = pileOffsets[index] || pileOffsets[pileOffsets.length - 1];
  return {
    left: `${8 + offset.x}px`,
    top: `${6 + offset.y}px`,
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

const drawCoverImage = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  focalY = 0.45
) => {
  const scale = Math.max(width / image.width, height / image.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = Math.max(0, (image.width - sourceWidth) / 2);
  const sourceY = Math.max(0, Math.min(image.height - sourceHeight, image.height * focalY - sourceHeight / 2));
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
};

const getWrappedLines = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
) => {
  const lines: string[] = [];
  let line = "";
  for (const character of Array.from(text)) {
    const candidate = `${line}${character}`;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = character;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  const consumed = lines.join("").length;
  if (consumed < Array.from(text).length && lines.length) {
    let lastLine = lines[lines.length - 1];
    while (lastLine && ctx.measureText(`${lastLine}…`).width > maxWidth) {
      lastLine = lastLine.slice(0, -1);
    }
    lines[lines.length - 1] = `${lastLine}…`;
  }
  return lines;
};

const drawWrappedText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
) => {
  const lines = getWrappedLines(ctx, text, maxWidth, maxLines);
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
  return lines.length;
};

export default function StickerCard({ result, equivalentId, onClose }: StickerCardProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const featuredEquivalent =
    result.equivalents.find((item) => item.id === equivalentId) || result.equivalents[0];
  const equivalentCount = featuredEquivalent ? Math.max(1, Math.round(Number(featuredEquivalent.count) || 1)) : 0;
  const maxVisiblePile = 6;
  const pileCount = featuredEquivalent ? Math.min(maxVisiblePile, equivalentCount) : 0;
  const punchline = getPersonaPunchline(result.levelCopy);
  const personaNameFontSize = result.level.length > 16 ? 15 : result.level.length > 12 ? 17 : result.level.length > 8 ? 19 : 22;
  const personaImageSrc = getPersonaStickerImageSrc(result.level);
  const shareUrl = useMemo(getShareUrl, []);

  useEffect(() => {
    let active = true;
    void createQrDataUrl(shareUrl, 6).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl);
    });
    return () => {
      active = false;
    };
  }, [shareUrl]);

  const saveSticker = async () => {
    if (!featuredEquivalent || isSaving) return;
    setIsSaving(true);
    try {
      const canvas = document.createElement("canvas");
      const width = 1080;
      const height = 1440;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "#d8c6a3");
      bg.addColorStop(0.48, "#ead6aa");
      bg.addColorStop(1, "#efe4c9");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.arc(920, 120, 210, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(110, 1220, 180, 0, Math.PI * 2);
      ctx.fill();

      const hero = { x: 70, y: 54, width: 940, height: 1075, radius: 54 };
      ctx.save();
      roundRect(ctx, hero.x, hero.y, hero.width, hero.height, hero.radius);
      ctx.clip();
      ctx.fillStyle = "#e3d6bd";
      ctx.fillRect(hero.x, hero.y, hero.width, hero.height);
      try {
        const personaImage = await loadImage(personaImageSrc);
        drawCoverImage(ctx, personaImage, hero.x - 28, hero.y, hero.width + 56, hero.height, 0.54);
      } catch {
        const fallback = ctx.createLinearGradient(hero.x, hero.y, hero.x + hero.width, hero.y + hero.height);
        fallback.addColorStop(0, "#d8c6a3");
        fallback.addColorStop(0.55, "#e4cfaa");
        fallback.addColorStop(1, "#eadfc5");
        ctx.fillStyle = fallback;
        ctx.fillRect(hero.x, hero.y, hero.width, hero.height);
      }

      const scrim = ctx.createLinearGradient(0, hero.y + 650, 0, hero.y + hero.height);
      scrim.addColorStop(0, "rgba(24,19,29,0)");
      scrim.addColorStop(0.38, "rgba(24,19,29,0.38)");
      scrim.addColorStop(1, "rgba(24,19,29,0.72)");
      ctx.fillStyle = scrim;
      ctx.fillRect(hero.x, hero.y + 620, hero.width, hero.height - 620);
      ctx.restore();

      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255,255,255,0.74)";
      ctx.font = "800 32px 'Microsoft YaHei', sans-serif";
      ctx.fillText("你的牛马身份", 96, 850);
      ctx.fillStyle = "#ffffff";
      let levelFontSize = 58;
      ctx.font = `950 ${levelFontSize}px 'Microsoft YaHei', sans-serif`;
      while (ctx.measureText(result.level).width > 888 && levelFontSize > 32) {
        levelFontSize -= 2;
        ctx.font = `950 ${levelFontSize}px 'Microsoft YaHei', sans-serif`;
      }
      ctx.fillText(result.level, 96, 914);

      ctx.fillStyle = "#ffffff";
      ctx.font = "900 29px 'Microsoft YaHei', sans-serif";
      const punchlineLines = getWrappedLines(ctx, punchline, 880, 2);
      const punchlineStartY = 986 - ((punchlineLines.length - 1) * 20);
      punchlineLines.forEach((line, index) => ctx.fillText(line, 96, punchlineStartY + index * 40));

      ctx.textAlign = "left";
      ctx.fillStyle = "#6d7785";
      ctx.font = "850 32px 'Microsoft YaHei', sans-serif";
      ctx.fillText("你的牛马身价约等于", 74, 1164);
      ctx.fillStyle = "#29384d";
      ctx.font = "950 80px 'Microsoft YaHei', sans-serif";
      ctx.fillText(`${featuredEquivalent.count}${featuredEquivalent.unit}`, 74, 1250);
      ctx.font = "900 34px 'Microsoft YaHei', sans-serif";
      drawWrappedText(ctx, featuredEquivalent.name, 74, 1302, 330, 42, 2);

      const iconSrc = getEquivalentIconSrc(featuredEquivalent.id, featuredEquivalent.name);
      if (iconSrc) {
        try {
          const image = await loadImage(iconSrc);
          const iconSize = 310;
          const baseX = 330;
          const baseY = 1098;
          for (let index = pileCount - 1; index >= 0; index -= 1) {
            const offset = pileOffsets[index] || pileOffsets[pileOffsets.length - 1];
            ctx.save();
            ctx.translate(baseX + iconSize / 2 + offset.x * 1.7, baseY + iconSize / 2 + offset.y * 1.7);
            ctx.rotate((offset.r * Math.PI) / 180);
            ctx.shadowColor = "rgba(58,48,66,0.2)";
            ctx.shadowBlur = 16;
            ctx.shadowOffsetY = 10;
            ctx.drawImage(image, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
            ctx.restore();
          }
        } catch {
          // The worth copy remains complete even if an optional icon asset fails.
        }
      }
      if (equivalentCount > maxVisiblePile) {
        ctx.fillStyle = "rgba(47,41,54,0.9)";
        roundRect(ctx, 564, 1302, 114, 56, 28);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.font = "900 27px 'Microsoft YaHei', sans-serif";
        ctx.fillText(`×${featuredEquivalent.count}`, 621, 1339);
      }

      const finalQrDataUrl = qrDataUrl || await createQrDataUrl(shareUrl, 8);
      const qrImage = await loadImage(finalQrDataUrl);
      ctx.drawImage(qrImage, 810, 1148, 154, 154);
      ctx.textAlign = "center";
      ctx.fillStyle = "#29384d";
      ctx.font = "900 25px 'Microsoft YaHei', sans-serif";
      ctx.fillText("扫码测测", 887, 1340);
      ctx.font = "900 22px 'Microsoft YaHei', sans-serif";
      ctx.fillText("你的牛马身份", 887, 1373);

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

          <section className="sticker-persona">
            <div className="sticker-persona-art">
              <img className="sticker-persona-image" src={personaImageSrc} alt={result.level} />
            </div>
            <div className="sticker-persona-copy">
              <span>你的牛马身份</span>
              <h2 style={{ fontSize: personaNameFontSize }}>{result.level}</h2>
              <strong>{punchline}</strong>
            </div>
          </section>

          <div className="sticker-secondary-grid">
            <section className="sticker-worth">
              <div className="sticker-worth-copy">
                <span>你的牛马身价约等于</span>
                <strong>
                  {featuredEquivalent?.count}
                  {featuredEquivalent?.unit}
                </strong>
                <b>{featuredEquivalent?.name}</b>
              </div>
              {featuredEquivalent && (
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
              )}
            </section>

            <section className="sticker-qr">
              {qrDataUrl ? <img src={qrDataUrl} alt="测试二维码" /> : <div className="sticker-qr-loading" />}
              <strong>扫码测测</strong>
              <span>你的牛马身份</span>
            </section>
          </div>
        </div>

        <div className="sticker-actions">
          <button className="save-sticker-button" type="button" onClick={saveSticker} disabled={isSaving || !featuredEquivalent}>
            {isSaving ? "正在生成图片" : "保存图片发朋友圈/状态"}
          </button>
          <p>人格是主角，身价和测试入口都收在下方。</p>
        </div>
      </div>
    </div>
  );
}
