const personaImageFileByName: Record<string, string> = {
  "工位出逃饿鬼": "1_1工位出逃饿鬼.png",
  "加班饿狼（已出笼版": "1_2加班饿狼（已出笼版.png",
  "快乐讨债吗喽": "2_1快乐讨债吗喽.png",
  "前司假期难民（烟花破防版": "2_2前司假期难民（烟花破防版.png",
  "窝囊费特种兵": "2_3窝囊废特种兵.png",
  "离职停机躺尸王（峡谷复活版": "3_1离职停机躺尸王（峡谷复活版.png",
  "996 缺觉熊（冬眠中": "3_3996睡眠难民（冬眠中.png",
  "脆皮牛马重装者（硬拉新生中": "4_1脆皮牛马重装者（硬拉新生中.png",
  "健身房复仇者（撸铁版": "4_2健身房复仇者（撸铁版.png",
  "工位陈年健身怪（回炉复建中": "4_3工位陈年健身怪（回炉复建中.png",
  "PUA 供能健身怪": "4_4PUA供能健身怪.png",
  "工位出逃野人": "5_1工位出逃野人.png",
  "工位断链野狗（远方撒野版": "5_2工位断链野狗（远方撒野版.png",
  "赛博筑巢牛马": "6_1赛博筑巢牛马.png",
  "工伤后遗症装备党（科学养牛版": "6_2工伤后遗症装备党（科学养牛版.png",
  "闲鱼捡漏拼装侠": "6_3闲鱼捡漏拼装侠.png",
  "工牌注销醉仙（牛马升天版": "7_1工牌注销醉仙（牛马升天版.png",
  "多年班味酒鬼": "7_2多年班味酒鬼.png",
  "幽怨加班酒鬼": "7_3幽怨加班酒鬼.png",
  "反骨创业野马": "8_1反骨创业野马.png",
  "自雇型卷王": "8_2自雇型卷王.png",
  "画饼转行烙饼户（猛猛加蛋版": "8_3画饼转行烙饼户（猛猛加料版.png"
};

export const splitPersonaCopy = (copy: string) => {
  const sentences = copy.match(/[^。！？]+[。！？]?[”’」』】）》）]?/g)?.map((item) => item.trim()).filter(Boolean) || [];
  if (sentences.length < 2) return [copy];
  return [
    sentences.slice(0, -1).join(""),
    sentences[sentences.length - 1] || ""
  ].filter(Boolean);
};

export const getPersonaPunchline = (copy: string) => {
  const paragraphs = splitPersonaCopy(copy);
  return paragraphs[paragraphs.length - 1] || copy;
};

export const getPersonaImageFile = (personaName: string) => {
  if (/\d+(?:\.\d+)?年陈酿咸鱼/.test(personaName)) return "3_2五年陈酿咸鱼.png";
  return personaImageFileByName[personaName] || `${personaName}.png`;
};

export const getPersonaImageSrc = (personaName: string) =>
  `/persona_images/${encodeURIComponent(getPersonaImageFile(personaName))}`;

export const getPersonaStickerImageSrc = (personaName: string) =>
  `/persona_images2/${encodeURIComponent(getPersonaImageFile(personaName))}`;
