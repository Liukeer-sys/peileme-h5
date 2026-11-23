export type CityKey =
  | "beijing"
  | "shanghai"
  | "guangzhou"
  | "shenzhen"
  | "hangzhou"
  | "wuhan"
  | "chengdu"
  | "xian"
  | "other";

export type WishEquivalentItem = {
  id: string;
  fantasyId: string;
  category: string;
  name: string;
  unitPrice: number;
  unit: string;
  text: string;
  cityKey?: CityKey;
  tier?: "low" | "mid" | "high";
  tags?: string[];
  /** 相同非 0 tag 代表“换一换”时属于同一种东西，只保留一个。 */
  tag: string;
};

type EquivalentSeed = {
  id: string;
  name: string;
  unitPrice: number;
  unit: string;
  text: string;
  tier?: "low" | "mid" | "high";
  tags?: string[];
  tag?: string;
};

const cityKeys: CityKey[] = [
  "beijing",
  "shanghai",
  "guangzhou",
  "shenzhen",
  "hangzhou",
  "wuhan",
  "chengdu",
  "xian",
  "other"
];

const makeItems = (
  fantasyId: string,
  category: string,
  seeds: EquivalentSeed[],
  cityKey?: CityKey
): WishEquivalentItem[] => seeds.map((seed) => ({
  ...seed,
  fantasyId,
  category,
  cityKey,
  tag: seed.tag || "0"
}));

const makeCityConfig = (
  fantasyId: string,
  category: string,
  seedsByCity: Record<CityKey, EquivalentSeed[]>
): Record<CityKey, WishEquivalentItem[]> => {
  const config = {} as Record<CityKey, WishEquivalentItem[]>;
  cityKeys.forEach((cityKey) => {
    config[cityKey] = makeItems(fantasyId, category, seedsByCity[cityKey], cityKey);
  });
  return config;
};

// 1. 先大吃特吃一顿：吃什么与所在城市关系最强，因此按城市配置。
const foodSeedsByCity: Record<CityKey, EquivalentSeed[]> = {
  beijing: [
    {
      id: "bj_roast_duck_feast",
      name: "四季民福烤鸭",
      unitPrice: 360,
      unit: "顿",
      text: "够你吃 `{count}` 顿四季民福烤鸭。 `{count}` 只鸭鸭下肚，抚慰受伤心灵。",
      tier: "mid",
      tags: ["local_food", "feast"]
    },
    {
      id: "bj_copper_hotpot",
      name: "聚宝源铜锅涮肉",
      unitPrice: 260,
      unit: "顿",
      text: "够你涮 `{count}` 顿聚宝源铜锅涮肉。羊肉蘸麻酱，烦恼全忘光，比周报治愈一百倍。",
      tier: "mid",
      tags: ["local_food", "hotpot"]
    },
    {
      id: "bj_guijie_crayfish",
      name: "簋街胡大小龙虾",
      unitPrice: 200,
      unit: "顿",
      text: "可以去簋街吃 `{count}` 顿小龙虾。以前老板扒我皮，现在我来扒虾皮。还要把手指嘬得震天响。",
      tier: "mid",
      tags: ["local_food", "hotpot"]
    }
  ],
  shanghai: [
    {
      id: "sh_wukang_wutong_coffee",
      name: "武康路梧桐区靠窗咖啡",
      unitPrice: 58,
      unit: "杯",
      text: "够你在武康路梧桐区喝 `{count}` 杯咖啡。班味散尽，梧桐絮飘进来比公司绿植有生命力多了。",
      tier: "high",
      tags: ["local_food", "coffee", "wutong_district"]
    },
    {
      id: "sh_gubei_japanese",
      name: "古北日料",
      unitPrice: 400,
      unit: "顿",
      text: "够你在古北吃 `{count}` 顿日料。破班先别管，厚切三文鱼清空所有烦恼。",
      tier: "high",
      tags: ["local_food", "japanese"]
    },
    {
      id: "sh_dahuchun_shengjian",
      name: "大壶春生煎",
      unitPrice: 30,
      unit: "顿",
      text: "够你吃 `{count}` 顿大壶春生煎。滚烫肉汁一口爆开，烫得我当场把裁员协议抛在脑后。",
      tier: "low",
      tags: ["local_food", "snack"]
    },
    {
      id: "sh_crab_noodle",
      name: "蟹粉面",
      unitPrice: 150,
      unit: "碗",
      text: "够你吃 `{count}` 碗蟹粉面。以前开一天会才舍得犒劳自己，现在可以连吃 `{count}` 天。",
      tier: "mid",
      tags: ["local_food", "noodle"]
    },
    {
      id: "sh_bund_brunch",
      name: "安福路 brunch",
      unitPrice: 280,
      unit: "顿",
      text: "够你在安福路吃 `{count}` 顿 brunch。周内吃brunch，才是真“松弛”好吧。",
      tier: "mid",
      tags: ["brunch", "feast"]
    },
    {
      id: "sh_laojishi_benbang",
      name: "老吉士本帮菜",
      unitPrice: 300,
      unit: "顿",
      text: "够你吃 `{count}` 顿老吉士。本帮菜浓油赤酱，把离职委屈也红烧了去。",
      tier: "mid",
      tags: ["brunch", "feast"]
    },
    {
      id: "sh_kaojiang",
      name: "烤匠",
      unitPrice: 140,
      unit: "顿",
      text: "够你吃 `{count}` 顿烤匠。周内随便去，妈妈再也不用担心我会排队。",
      tier: "mid",
      tags: ["brunch", "feast"]
    }
  ],
  guangzhou: [
    {
      id: "gz_diandude_yumcha",
      name: "点都德早茶",
      unitPrice: 120,
      unit: "次",
      text: "够你吃 `{count}` 次点都德。以前老板什么都要，现在点什么都得。",
      tier: "mid",
      tags: ["local_food", "yumcha"]
    },
    {
      id: "gz_yinji_rice_roll",
      name: "银记肠粉",
      unitPrice: 35,
      unit: "顿",
      text: "够你吃 `{count}` 顿银记肠粉。肠粉滑溜，烦恼全滑走。",
      tier: "low",
      tags: ["local_food", "snack"]
    },
    {
      id: "gz_yumcha",
      name: "陶陶居早茶",
      unitPrice: 130,
      unit: "顿",
      text: "够你叹 {count} 顿陶陶居早茶。不用赶早会，虾饺可以一笼一笼慢慢点。",
      tier: "mid",
      tags: ["local_food", "yumcha"]
    },
    {
      id: "gz_roast_goose",
      name: "惠食佳啫啫煲",
      unitPrice: 180,
      unit: "顿",
      text: "够你吃 `{count}` 顿惠食佳啫啫煲。怒气不用再憋，砂锅替你滋啦作响。",
      tier: "mid",
      tags: ["local_food", "feast"]
    }
  ],
  shenzhen: [
    {
      id: "sz_muwu_bbq",
      name: "木屋烧烤",
      unitPrice: 150,
      unit: "顿",
      text: "够你吃 `{count}` 顿木屋烧烤。放心撸串至后半夜，不必担心明日早朝。",
      tier: "mid",
      tags: ["local_food", "bbq"]
    },
    {
      id: "sz_shekou_seafood",
      name: "蛇口海鲜",
      unitPrice: 300,
      unit: "顿",
      text: "够你去蛇口吃 `{count}` 顿海鲜。海风一吹，班味自动下线。",
      tier: "high",
      tags: ["local_food", "seafood"]
    },
    {
      id: "sz_huaqiangbei_pork_rice",
      name: "华强北猪脚饭",
      unitPrice: 30,
      unit: "顿",
      text: "够你吃 `{count}` 顿猪脚饭。手机没电去华强北，你没电吃猪脚饭。",
      tier: "low",
      tags: ["local_food", "rice"]
    },
    {
      id: "sz_beef_hotpot",
      name: "八合里潮汕牛肉火锅",
      unitPrice: 180,
      unit: "顿",
      text: "够你吃 {count} 顿八合里潮汕牛肉火锅。三起三落的牛肉，致敬大起大落的人生。",
      tier: "mid",
      tags: ["local_food", "hotpot"]
    },
    {
      id: "sz_coconut_chicken",
      name: "润园四季椰子鸡",
      unitPrice: 190,
      unit: "顿",
      text: "够你吃 {count} 顿椰子鸡。椰子给的这般滋养，前司从未给过孩儿。",
      tier: "mid",
      tags: ["local_food", "feast"]
    }
  ],
  hangzhou: [
    {
      id: "hz_waipojia",
      name: "外婆家",
      unitPrice: 120,
      unit: "顿",
      text: "够你吃 `{count}` 顿外婆家。不用回工作消息的日子，记得回外婆家。",
      tier: "mid",
      tags: ["local_food", "feast"]
    },
    {
      id: "hz_xinbailu",
      name: "新白鹿",
      unitPrice: 100,
      unit: "顿",
      text: "够你吃 `{count}` 顿新白鹿。离职手续办完，糖醋里脊负责接风。",
      tier: "mid",
      tags: ["local_food", "feast"]
    },
    {
      id: "hz_louwailou",
      name: "楼外楼",
      unitPrice: 250,
      unit: "顿",
      text: "够你去楼外楼吃 `{count}` 顿。行业前景抛至脑后，西湖风景徐徐展开。",
      tier: "high",
      tags: ["local_food", "feast"]
    },
    {
      id: "hz_zhiweiguan_combo",
      name: "知味观小吃套餐",
      unitPrice: 50,
      unit: "顿",
      text: "够你吃 `{count}` 顿知味观。职场没滋没味，小笼、猫耳朵唤醒人生滋味",
      tier: "low",
      tags: ["local_food", "snack"]
    },
    {
      id: "hz_longjing_shrimp",
      name: "龙井虾仁",
      unitPrice: 180,
      unit: "盘",
      text: "够你吃 {count} 盘龙井虾仁。看看人家龙井都能配虾仁，你也能跨界到更好的。",
      tier: "mid",
      tags: ["local_food", "feast"]
    }
  ],
  wuhan: [
    {
      id: "wh_sanzhen_breakfast",
      name: "三镇民生甜食馆过早套餐",
      unitPrice: 30,
      unit: "次",
      text: "够你去三镇民生过早 `{count}` 次。不上早班，安心过早。",
      tier: "low",
      tags: ["local_food", "breakfast"]
    },
    {
      id: "wh_laotongcheng_doupi",
      name: "老通城豆皮",
      unitPrice: 25,
      unit: "顿",
      text: "够你吃 `{count}` 顿老通城豆皮。蛋皮、糯米、三鲜各就各位，这组织架构没得挑。",
      tier: "low",
      tags: ["local_food", "breakfast"]
    },
    {
      id: "wh_hot_dry_noodle",
      name: "蔡林记热干面",
      unitPrice: 18,
      unit: "碗",
      text: "够你吃 {count} 碗蔡林记热干面。工作没了可以再找，面坨了是真没救。",
      tier: "low",
      tags: ["local_food", "noodle"]
    },
    {
      id: "wh_crayfish",
      name: "肥肥虾庄",
      unitPrice: 180,
      unit: "顿",
      text: "够你去肥肥虾庄吃 `{count}` 顿武汉小龙虾。这次不是公司剥你壳，是你剥虾壳。",
      tier: "mid",
      tags: ["local_food", "feast"]
    }
  ],
  chengdu: [
    {
      id: "cd_shudaxia_dalongyi_hotpot",
      name: "蜀大侠",
      unitPrice: 180,
      unit: "顿",
      text: "够你吃 `{count}` 顿蜀大侠。工作让你透心凉，但锅底火热。",
      tier: "mid",
      tags: ["local_food", "hotpot"]
    },
    {
      id: "cd_xiaojungan_skewers",
      name: "钢管厂五区小郡肝串串",
      unitPrice: 120,
      unit: "顿",
      text: "够你撸 `{count}` 顿串串。以前算工时，现在数签签。",
      tier: "mid",
      tags: ["local_food", "skewers"]
    },
    {
      id: "cd_spicy_hotpot",
      name: "小龙坎火锅",
      unitPrice: 240,
      unit: "顿",
      text: "够你吃 {count} 顿小龙坎火锅。再也不必因为工作七上八下！现在轮到毛肚七上八下。",
      tier: "mid",
      tags: ["local_food", "hotpot"]
    },
    {
      id: "cd_skewers",
      name: "陈麻婆豆腐",
      unitPrice: 100,
      unit: "顿",
      text: "够你吃 `{count}` 顿陈麻婆。职场可以平淡，麻婆豆腐可不行。",
      tier: "low",
      tags: ["local_food", "feast"]
    }
  ],
  xian: [
    {
      id: "xa_xian_restaurant_gourd_chicken",
      name: "西安饭庄葫芦鸡",
      unitPrice: 150,
      unit: "顿",
      text: "够你吃 `{count}` 顿葫芦鸡。下一步做什么先别管，先咥 `{count}` 只葫芦鸡。",
      tier: "mid",
      tags: ["local_food", "feast"]
    },
    {
      id: "xa_mixc_feast",
      name: "万象城大吃一顿",
      unitPrice: 250,
      unit: "顿",
      text: "够你在万象城吃 `{count}` 顿大餐。工作翻篇，去生命之树重启人生，万象更新",
      tier: "high",
      tags: ["local_food", "feast"]
    },
    {
      id: "xa_skp_feast",
      name: "西安 SKP 大餐",
      unitPrice: 400,
      unit: "顿",
      text: "够你在西安 SKP 吃 `{count}` 顿大餐。KPI 先放下，SKP 先逛下。",
      tier: "high",
      tags: ["local_food", "feast"]
    },
    {
      id: "xa_pita_bread_mutton",
      name: "老米家羊肉泡馍",
      unitPrice: 55,
      unit: "碗",
      text: "够你吃 {count} 碗老米家羊肉泡馍。前司画的饼吃不着，这个饼是真好吃。",
      tier: "low",
      tags: ["local_food", "soup"]
    },
    {
      id: "xa_roujiamo_combo",
      name: "肉夹馍凉皮冰峰套餐",
      unitPrice: 32,
      unit: "套",
      text: "够你吃 {count} 套三秦套餐。工作可以散，肉夹馍凉皮冰峰不能散。",
      tier: "low",
      tags: ["local_food", "combo"]
    }
  ],
  other: [
    {
      id: "luckin-99",
      name: "9.9 元瑞幸",
      unitPrice: 9.9,
      unit: "杯",
      text: "够你喝 `{count}` 杯 9.9 元瑞幸。不在工位喝的瑞幸就是香",
      tier: "low",
      tags: ["coffee"]
    },
    {
      id: "chagee-boya",
      name: "霸王茶姬伯牙绝弦",
      unitPrice: 20,
      unit: "杯",
      text: "够你喝 `{count}` 杯伯牙绝弦。下午也可以随便喝，不用担心失眠影响第二天的工作。",
      tier: "low",
      tags: ["milk_tea"]
    },
    {
      id: "shaxian-chicken-set",
      name: "沙县小吃鸡腿套餐",
      unitPrice: 22,
      unit: "份",
      text: "够你吃 `{count}` 份沙县小吃鸡腿套餐。今天不加班，加鸡腿。",
      tier: "low",
      tags: ["meal", "combo"]
    },
    {
      id: "mixue-lemonade",
      name: "蜜雪冰城冰鲜柠檬水",
      unitPrice: 4,
      unit: "杯",
      text: "够你喝 `{count}` 杯蜜雪冰城冰鲜柠檬水。每天喝他个3杯，能喝 {monthsAtThreePerDay} 个月。",
      tier: "low",
      tags: ["lemonade"]
    },
    {
      id: "zhangliang",
      name: "张亮麻辣烫",
      unitPrice: 30,
      unit: "份",
      text: "够你吃 `{count}` 份张亮麻辣烫。离职后第一场自主招聘：想吃的都招进碗里。",
      tier: "low",
      tags: ["meal", "malatang"]
    },
    {
      id: "other_hotpot_feast",
      name: "海底捞",
      unitPrice: 320,
      unit: "顿",
      text: "够你吃 {count} 顿海底捞。以前像捞面一样被随意操纵的生活结束了！",
      tier: "mid",
      tags: ["hotpot", "feast"]
    },
    {
      id: "huangmenji",
      name: "黄焖鸡米饭",
      unitPrice: 25,
      unit: "顿",
      text: "够你吃 `{count}` 顿黄焖鸡。再也不听毒鸡汤，现在吃肉又喝汤。",
      tier: "low",
      tags: ["buffet", "feast"]
    }
  ]
};

export const foodEquivalentConfig = makeCityConfig("food_feast", "城市美食", foodSeedsByCity);

// 2. 出门玩个痛快：本地乐园和演出最有代入感，因此也按城市配置。
const makeSharedDestinationSeeds = (
  cityKey: Exclude<CityKey, "beijing" | "shanghai">
): EquivalentSeed[] => [
  {
    id: `${cityKey}_universal_express`,
    name: "环球影城优速通套餐",
    unitPrice: 1650,
    unit: "次",
    text: "够你在环球影城爽玩 {count} 次。好想在好莱坞电影中活一次，先在环球里连待 {count} 天，平替一下吧！",
    tier: "mid",
    tags: ["theme_park", "destination_trip"]
  },
  {
    id: `${cityKey}_shanghai_disney_premium`,
    name: "上海迪士尼尊享套装",
    unitPrice: 1500,
    unit: "次",
    text: "够你在迪士尼爽玩 {count} 次。从现在起你就是迪士尼里的公主王子，不必给任何人好脸色！",
    tier: "mid",
    tags: ["theme_park", "destination_trip"]
  }
];

const funSeedsByCity: Record<CityKey, EquivalentSeed[]> = {
  beijing: [
    {
      id: "bj_korea_fandom_trip",
      name: "北京出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从北京出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "bj_universal_ticket",
      name: "环球影城优速通套餐",
      unitPrice: 1650,
      unit: "次",
      text: "够你在环球影城爽玩 {count} 次。好想在好莱坞电影中活一次，先在环球里连待 {count} 天，平替一下吧！",
      tier: "mid",
      tags: ["theme_park"]
    },
    {
      id: "bj_concert_ticket",
      name: "鸟巢演唱会内场票",
      unitPrice: 1800,
      unit: "张",
      text: "够你买 {count} 张鸟巢演唱会内场票。我的正主/本命/宝宝/女神/心肝，我来看你们了~",
      tier: "high",
      tags: ["concert"]
    },
    {
      id: "bj_ncpa_concert",
      name: "国家大剧院音乐会",
      unitPrice: 480,
      unit: "场",
      text: "够你去国家大剧院听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "theatre"]
    },
    {
      id: "bj_xiangsheng_show",
      name: "北京相声专场",
      unitPrice: 200,
      unit: "场",
      text: "够你听 {count} 场相声。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["xiangsheng", "comedy"]
    }
  ],
  shanghai: [
    {
      id: "sh_korea_fandom_trip",
      name: "上海出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从上海出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "sh_disney_ticket",
      name: "上海迪士尼尊享套装",
      unitPrice: 1500,
      unit: "次",
      text: "够你在迪士尼爽玩 {count} 次。从现在起你就是迪士尼里的公主王子，不必给任何人好脸色！",
      tier: "mid",
      tags: ["theme_park"]
    },
    {
      id: "sh_musical_ticket",
      name: "上海大剧院音乐剧",
      unitPrice: 900,
      unit: "场",
      text: "够你去上海大剧院看 {count} 场音乐剧。去坐前排，去选喜欢的卡司，冲啊！",
      tier: "high",
      tags: ["theatre"]
    },
    {
      id: "sh_standup_comedy_ticket",
      name: "脱口秀",
      unitPrice: 280,
      unit: "场",
      text: "够你在上海看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "sh_symphony_hall_concert",
      name: "上海交响音乐厅音乐会",
      unitPrice: 480,
      unit: "场",
      text: "够你去上海交响音乐厅听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "concert_hall"]
    },
    {
      id: "sh_west_bund_museum_exhibition",
      name: "西岸美术馆看展",
      unitPrice: 100,
      unit: "场",
      text: "够你去西岸美术馆看 {count} 场展。什么 PPT、HTML 都弱爆了，现在来看看有审美的。",
      tier: "mid",
      tags: ["exhibition", "art"]
    },
    {
      id: "sh_mercedes_benz_arena_concert",
      name: "梅赛德斯-奔驰文化中心演唱会内场票",
      unitPrice: 1380,
      unit: "张",
      text: "够你买 {count} 张梅赛德斯-奔驰文化中心演唱会内场票。班味退、退、退！Live 现场顶顶顶。",
      tier: "high",
      tags: ["concert"]
    }
  ],
  guangzhou: [
    ...makeSharedDestinationSeeds("guangzhou"),
    {
      id: "gz_korea_fandom_trip",
      name: "广州出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从广州出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "gz_standup_comedy_ticket",
      name: "脱口秀",
      unitPrice: 180,
      unit: "场",
      text: "够你在广州看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "gz_xinghai_concert",
      name: "星海音乐厅音乐会",
      unitPrice: 380,
      unit: "场",
      text: "够你去星海音乐厅听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "concert_hall"]
    },
    {
      id: "gz_chimelong_safari_ticket",
      name: "长隆野生动物世界门票",
      unitPrice: 350,
      unit: "次",
      text: "够你去 {count} 次长隆野生动物世界。我要退化成猴子，和野生动物待在一起，再也不上班。",
      tier: "mid",
      tags: ["theme_park"]
    },
    {
      id: "gz_concert_ticket",
      name: "天河体育中心演唱会内场票",
      unitPrice: 1880,
      unit: "张",
      text: "够你买 {count} 张天河体育中心演唱会内场票。我的正主/本命/宝宝/女神/心肝，我来看你们了~",
      tier: "high",
      tags: ["concert"]
    }
  ],
  shenzhen: [
    ...makeSharedDestinationSeeds("shenzhen"),
    {
      id: "sz_korea_fandom_trip",
      name: "深圳出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从深圳出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "sz_standup_comedy_ticket",
      name: "脱口秀",
      unitPrice: 220,
      unit: "场",
      text: "够你在深圳看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "sz_concert_hall_concert",
      name: "深圳音乐厅音乐会",
      unitPrice: 380,
      unit: "场",
      text: "够你去深圳音乐厅听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "concert_hall"]
    },
    {
      id: "sz_happy_valley_ticket",
      name: "欢乐谷门票",
      unitPrice: 260,
      unit: "次",
      text: "够你去 {count} 次欢乐谷。以前心跳因飞书消息而加速，现在因过山车而狂跳。",
      tier: "mid",
      tags: ["theme_park"]
    },
    {
      id: "sz_spring_cocoon_concert",
      name: "深圳湾“春茧”演唱会票",
      unitPrice: 1880,
      unit: "张",
      text: "够你买 {count} 张深圳湾“春茧”演唱会票。我的正主/本命/宝宝/女神/心肝，我来看你们了~",
      tier: "high",
      tags: ["concert"]
    },
    {
      id: "sz_poly_theatre_ticket",
      name: "深圳保利剧院话剧票",
      unitPrice: 600,
      unit: "张",
      text: "够你买 {count} 张深圳保利剧院话剧票。去坐前排，去选喜欢的卡司，冲啊！",
      tier: "mid",
      tags: ["theatre", "drama"]
    }
  ],
  hangzhou: [
    ...makeSharedDestinationSeeds("hangzhou"),
    {
      id: "hz_korea_fandom_trip",
      name: "杭州出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从杭州出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "hz_olympic_concert_ticket",
      name: "杭州奥体中心演唱会内场票",
      unitPrice: 1880,
      unit: "张",
      text: "够你买 {count} 张杭州奥体中心演唱会内场票。我的正主/本命/宝宝/女神/心肝，我来看你们了~",
      tier: "high",
      tags: ["concert"]
    },
    {
      id: "hz_grand_theatre_drama_ticket",
      name: "杭州大剧院话剧票",
      unitPrice: 600,
      unit: "张",
      text: "够你买 {count} 张杭州大剧院话剧票。去坐前排，去选喜欢的卡司，冲啊！",
      tier: "mid",
      tags: ["theatre", "drama"]
    },
    {
      id: "hz_standup_comedy_ticket",
      name: "杭州脱口秀专场",
      unitPrice: 180,
      unit: "场",
      text: "够你在杭州看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "hz_grand_theatre_concert",
      name: "杭州大剧院音乐会",
      unitPrice: 380,
      unit: "场",
      text: "够你去杭州大剧院听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "concert_hall"]
    }
  ],
  wuhan: [
    ...makeSharedDestinationSeeds("wuhan"),
    {
      id: "wh_korea_fandom_trip",
      name: "武汉出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从武汉出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "wh_standup_comedy_ticket",
      name: "脱口秀",
      unitPrice: 160,
      unit: "场",
      text: "够你在武汉看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "wh_qintai_concert",
      name: "琴台音乐厅音乐会",
      unitPrice: 300,
      unit: "场",
      text: "够你去琴台音乐厅听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "concert_hall"]
    },
    {
      id: "wh_happy_valley_ticket",
      name: "武汉欢乐谷门票",
      unitPrice: 230,
      unit: "次",
      text: "够你去 {count} 次欢乐谷。以前心跳因飞书消息而加速，现在因过山车而狂跳。",
      tier: "mid",
      tags: ["theme_park"]
    },
    {
      id: "wh_concert_ticket",
      name: "武汉体育中心演唱会内场票",
      unitPrice: 1880,
      unit: "张",
      text: "够你买 {count} 张武汉体育中心演唱会内场票。班味退、退、退！Live 现场顶顶顶。",
      tier: "high",
      tags: ["concert"]
    }
  ],
  chengdu: [
    ...makeSharedDestinationSeeds("chengdu"),
    {
      id: "cd_korea_fandom_trip",
      name: "成都出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从成都出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "cd_happy_valley_ticket",
      name: "成都欢乐谷门票",
      unitPrice: 260,
      unit: "次",
      text: "够你去 {count} 次成都欢乐谷。以前心跳因飞书消息而加速，现在因过山车而狂跳。",
      tier: "mid",
      tags: ["theme_park", "roller_coaster"]
    },
    {
      id: "cd_dongan_lake_concert_ticket",
      name: "东安湖体育公园演唱会内场票",
      unitPrice: 1680,
      unit: "张",
      text: "够你买 {count} 张东安湖体育公园演唱会内场票。班味退、退、退！Live 现场顶顶顶。",
      tier: "high",
      tags: ["concert"]
    },
    {
      id: "cd_panda_day",
      name: "熊猫基地快乐一日游",
      unitPrice: 120,
      unit: "次",
      text: "够你去看 {count} 次熊猫。看看人家上班：吃饭、睡觉、翻个身，全公司还怕它不开心。",
      tier: "low",
      tags: ["city_fun"]
    },
    {
      id: "cd_comedy_ticket",
      name: "脱口秀",
      unitPrice: 220,
      unit: "场",
      text: "够你在成都看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "cd_city_concert_hall",
      name: "成都城市音乐厅音乐会",
      unitPrice: 300,
      unit: "场",
      text: "够你去成都城市音乐厅听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "concert_hall"]
    }
  ],
  xian: [
    ...makeSharedDestinationSeeds("xian"),
    {
      id: "xa_korea_fandom_trip",
      name: "西安出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从西安出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "xa_lehua_city_ticket",
      name: "西安乐华城欢乐世界门票",
      unitPrice: 220,
      unit: "次",
      text: "够你去 {count} 次西安乐华城欢乐世界。以前心跳因飞书消息而加速，现在因过山车而狂跳。",
      tier: "mid",
      tags: ["theme_park", "roller_coaster"]
    },
    {
      id: "xa_standup_comedy_ticket",
      name: "脱口秀",
      unitPrice: 160,
      unit: "场",
      text: "够你在西安看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "xa_concert_hall_concert",
      name: "西安音乐厅音乐会",
      unitPrice: 300,
      unit: "场",
      text: "够你去西安音乐厅听 {count} 场音乐会。和老板的车轱辘话说拜拜，和高雅音乐说嗨嗨。",
      tier: "mid",
      tags: ["classical_music", "concert_hall"]
    },
    {
      id: "xa_changhenge_ticket",
      name: "《长恨歌》演出门票",
      unitPrice: 400,
      unit: "场",
      text: "够你看 {count} 场《长恨歌》。对前司的恨，就像绵绵东流水。",
      tier: "mid",
      tags: ["theatre"]
    },
    {
      id: "xa_tang_show_ticket",
      name: "奥体中心演唱会内场票",
      unitPrice: 1880,
      unit: "场",
      text: "够你去奥体中心看 {count} 演唱会。班味退、退、退！Live 现场顶顶顶。",
      tier: "mid",
      tags: ["city_fun"]
    }
  ],
  other: [
    ...makeSharedDestinationSeeds("other"),
    {
      id: "other_korea_fandom_trip",
      name: "本地出发韩国追星之旅",
      unitPrice: 10000,
      unit: "次",
      text: "够你从所在城市出发去韩国追星 {count} 次。工牌丢掉，应援棒举上。",
      tier: "high",
      tags: ["fandom", "korea_trip"]
    },
    {
      id: "other_standup_comedy_ticket",
      name: "脱口秀",
      unitPrice: 180,
      unit: "场",
      text: "够你看 {count} 场脱口秀。再也不必给老板赔笑，现在让专业人士逗你笑。",
      tier: "mid",
      tags: ["standup", "comedy"]
    },
    {
      id: "other_theme_park_ticket",
      name: "游乐场门票",
      unitPrice: 300,
      unit: "次",
      text: "够你去 {count} 次游乐场。以前心跳因飞书消息而加速，现在因过山车而狂跳。",
      tier: "mid",
      tags: ["theme_park"]
    },
    {
      id: "other_concert_ticket",
      name: "演唱会内场门票",
      unitPrice: 1880,
      unit: "场",
      text: "够你在内场看 {count} 场演唱会。我的正主/本命/宝宝/女神/心肝，我来看你们了~",
      tier: "high",
      tags: ["concert"]
    }
  ]
};

export const funEquivalentConfig = makeCityConfig("go_have_fun", "出门玩乐", funSeedsByCity);

// 3. 去喝个痛快：酒吧体验与城市夜生活有关，因此按城市配置。
const drinkSeedsByCity: Record<CityKey, EquivalentSeed[]> = {
  beijing: [
    {
      id: "bj_sanlitun_cocktail",
      name: "三里屯鸡尾酒",
      unitPrice: 120,
      unit: "杯",
      text: "够你在三里屯点 {count} 杯鸡尾酒。赔偿到账，今晚放开了喝。",
      tier: "mid",
      tags: ["cocktail", "sanlitun"]
    },
    {
      id: "bj_cbd_champagne",
      name: "国贸云端香槟",
      unitPrice: 180,
      unit: "杯",
      text: "够你在国贸高空喝 {count} 杯香槟。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["champagne", "rooftop", "cbd"]
    },
    {
      id: "bj_liangma_martini",
      name: "亮马河马天尼",
      unitPrice: 120,
      unit: "杯",
      text: "够你在亮马河喝 {count} 杯马天尼。河边一坐，工位那点事随风飘散。",
      tier: "mid",
      tags: ["cocktail", "martini", "riverside"]
    },
    {
      id: "bj_houhai_gin_tonic",
      name: "后海金汤力",
      unitPrice: 80,
      unit: "杯",
      text: "够你在后海喝 {count} 杯金汤力。班可以不上，气泡必须上头。",
      tier: "low",
      tags: ["cocktail", "houhai"]
    },
    {
      id: "bj_wangjing_korean_soju",
      name: "望京韩式烧酒",
      unitPrice: 70,
      unit: "瓶",
      text: "够你在望京喝 {count} 瓶韩式烧酒。今晚一口闷，再也不用管工作群里的消息。",
      tier: "low",
      tags: ["soju", "wangjing"]
    }
  ],
  shanghai: [
    {
      id: "sh_bund_rooftop_cocktail",
      name: "外滩鸡尾酒",
      unitPrice: 180,
      unit: "杯",
      text: "够你在外滩喝 {count} 杯鸡尾酒。黄浦江会见证你的翻身。",
      tier: "high",
      tags: ["cocktail", "rooftop", "bund"]
    },
    {
      id: "sh_lujiazui_champagne",
      name: "陆家嘴云端香槟",
      unitPrice: 220,
      unit: "杯",
      text: "够你在陆家嘴喝 {count} 杯香槟。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["champagne", "rooftop", "lujiazui"]
    },
    {
      id: "sh_anfu_road_martini",
      name: "安福路马天尼",
      unitPrice: 130,
      unit: "杯",
      text: "够你在安福路喝 {count} 杯马天尼。工牌丢了去，腔调端上来。",
      tier: "mid",
      tags: ["cocktail", "martini", "anfu_road"]
    },
    {
      id: "sh_jufuchang_long_island_iced_tea",
      name: "巨富长长岛冰茶",
      unitPrice: 130,
      unit: "杯",
      text: "够你在巨富长喝 {count} 杯长岛冰茶。前司令人下头，长岛冰茶负责让人上头！",
      tier: "mid",
      tags: ["cocktail", "long_island_iced_tea", "jufuchang"]
    },
    {
      id: "sh_ins_dance_night",
      name: "INS 新乐园蹦迪夜",
      unitPrice: 250,
      unit: "晚",
      text: "够你去 INS 新乐园蹦 {count} 晚。白天被裁，晚上开蹦。",
      tier: "high",
      tags: ["dance", "nightlife", "ins"]
    },
    {
      id: "sh_wukang_mojito",
      name: "武康路莫吉托",
      unitPrice: 140,
      unit: "杯",
      text: "够你在武康路喝 {count} 杯莫吉托。梧桐夜色里，班味随风消散。",
      tier: "mid",
      tags: ["cocktail", "mojito", "wukang_road"]
    },
    {
      id: "sh_xintiandi_shot",
      name: "新天地 Shot",
      unitPrice: 50,
      unit: "杯",
      text: "够你在新天地喝 {count} 杯 Shot。一口送走一个破需求。",
      tier: "low",
      tags: ["shot", "nightlife", "xintiandi"]
    }
  ],
  guangzhou: [
    {
      id: "gz_zhujiang_rooftop_night",
      name: "珠江新城鸡尾酒",
      unitPrice: 140,
      unit: "杯",
      text: "够你在珠江新城喝 {count} 杯鸡尾酒。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["cocktail", "rooftop"]
    },
    {
      id: "gz_dongshankou_martini",
      name: "东山口马天尼",
      unitPrice: 120,
      unit: "杯",
      text: "够你在东山口喝 {count} 杯马天尼。工牌丢了去，腔调端上来",
      tier: "mid",
      tags: ["cocktail", "martini", "dongshankou"]
    },
    {
      id: "long_island_iced_tea",
      name: "琶醍长岛冰茶",
      unitPrice: 100,
      unit: "杯",
      text: "够你在琶醍喝 {count} 杯长岛冰茶。前司令人下头，长岛冰茶负责让人上头！",
      tier: "mid",
      tags: ["cocktail", "long_island_iced_tea", "party_pier"]
    },
    {
      id: "gz_yanjiang_mojito",
      name: "沿江路莫吉托",
      unitPrice: 120,
      unit: "杯",
      text: "够你在沿江路喝 {count} 杯莫吉托。江风一吹，工位那点事随风飘散。",
      tier: "mid",
      tags: ["cocktail", "mojito", "yanjiang_road"]
    },
    {
      id: "gz_yuanjing_korean_soju",
      name: "远景路韩式烧酒",
      unitPrice: 60,
      unit: "瓶",
      text: "够你在远景路喝 {count} 瓶韩式烧酒。今晚一口闷，再也不用管工作群里的消息。",
      tier: "low",
      tags: ["soju", "korean_street", "yuanjing_road"]
    }
  ],
  shenzhen: [
    {
      id: "sz_futian_cbd_champagne",
      name: "福田 CBD 云端香槟",
      unitPrice: 220,
      unit: "杯",
      text: "够你在福田 CBD 喝 {count} 杯香槟。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["champagne", "rooftop", "futian_cbd"]
    },
    {
      id: "sz_seaworld_mojito",
      name: "海上世界莫吉托",
      unitPrice: 120,
      unit: "杯",
      text: "够你在海上世界喝 {count} 杯莫吉托。海风一吹，班味自动退出群聊。",
      tier: "mid",
      tags: ["cocktail", "mojito", "seaworld"]
    },
    {
      id: "sz_coco_park_long_island_iced_tea",
      name: "购物公园长岛冰茶",
      unitPrice: 120,
      unit: "杯",
      text: "够你在购物公园喝 {count} 杯长岛冰茶。前司已经下头，长岛冰茶负责上头。",
      tier: "mid",
      tags: ["cocktail", "long_island_iced_tea", "coco_park"]
    },
    {
      id: "sz_mixc_world_martini",
      name: "万象天地马天尼",
      unitPrice: 130,
      unit: "杯",
      text: "够你在万象天地喝 {count} 杯马天尼。工牌一丢，腔调上桌。",
      tier: "mid",
      tags: ["cocktail", "martini", "mixc_world"]
    },
    {
      id: "sz_shuiwei_shot",
      name: "水围 1368 Shot",
      unitPrice: 50,
      unit: "杯",
      text: "够你在水围 1368 喝 {count} 杯 Shot。一口送走一个破需求。",
      tier: "low",
      tags: ["shot", "nightlife", "shuiwei"]
    }
  ],
  hangzhou: [
    {
      id: "hz_hubin_cocktail",
      name: "湖滨鸡尾酒",
      unitPrice: 120,
      unit: "杯",
      text: "够你在湖滨喝 {count} 杯鸡尾酒。西湖会见证你的咸鱼翻身！",
      tier: "mid",
      tags: ["cocktail", "lakeside"]
    },
    {
      id: "hz_nanshan_road_martini",
      name: "南山路马天尼",
      unitPrice: 130,
      unit: "杯",
      text: "够你在南山路喝 {count} 杯马天尼。工牌一丢，腔调上桌。",
      tier: "mid",
      tags: ["cocktail", "martini", "nanshan_road"]
    },
    {
      id: "hz_tianmuli_gin_tonic",
      name: "天目里金汤力",
      unitPrice: 100,
      unit: "杯",
      text: "够你在天目里喝 {count} 杯金汤力。班可以不上，气泡必须上头。",
      tier: "mid",
      tags: ["cocktail", "gin_tonic", "tianmuli"]
    },
    {
      id: "hz_canal_world_mojito",
      name: "运河天地莫吉托",
      unitPrice: 100,
      unit: "杯",
      text: "够你在运河天地喝 {count} 杯莫吉托。河风一吹，班味随风消散。",
      tier: "mid",
      tags: ["cocktail", "mojito", "canal_world"]
    },
    {
      id: "hz_wulin_road_shot",
      name: "武林路 Shot",
      unitPrice: 50,
      unit: "杯",
      text: "够你在武林路喝 {count} 杯 Shot。一口送走一个破需求。",
      tier: "low",
      tags: ["shot", "nightlife", "wulin_road"]
    }
  ],
  wuhan: [
    {
      id: "wh_wuhan_tiandi_champagne",
      name: "武汉天地香槟",
      unitPrice: 180,
      unit: "杯",
      text: "够你在武汉天地喝 {count} 杯香槟。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["champagne", "wuhan_tiandi"]
    },
    {
      id: "wh_lihuangpi_martini",
      name: "黎黄陂路马天尼",
      unitPrice: 110,
      unit: "杯",
      text: "够你在黎黄陂路喝 {count} 杯马天尼。工牌一丢，腔调上桌。",
      tier: "mid",
      tags: ["cocktail", "martini", "lihuangpi_road"]
    },
    {
      id: "wh_hankou_riverside_mojito",
      name: "汉口江滩莫吉托",
      unitPrice: 90,
      unit: "杯",
      text: "够你在汉口江滩喝 {count} 杯莫吉托。江风一吹，班味随风消散。",
      tier: "mid",
      tags: ["cocktail", "mojito", "hankou_riverside"]
    },
    {
      id: "wh_jianghan_long_island_iced_tea",
      name: "江汉路长岛冰茶",
      unitPrice: 100,
      unit: "杯",
      text: "够你在江汉路喝 {count} 杯长岛冰茶。前司已经下头，长岛冰茶负责上头。",
      tier: "mid",
      tags: ["cocktail", "long_island_iced_tea", "jianghan_road"]
    },
    {
      id: "wh_optics_valley_shot",
      name: "光谷 Shot",
      unitPrice: 50,
      unit: "杯",
      text: "够你在光谷喝 {count} 杯 Shot。一口送走一个破需求。",
      tier: "low",
      tags: ["shot", "nightlife", "optics_valley"]
    }
  ],
  chengdu: [
    {
      id: "cd_taikoo_li_champagne",
      name: "太古里香槟",
      unitPrice: 180,
      unit: "杯",
      text: "够你在太古里喝 {count} 杯香槟。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["champagne", "taikoo_li"]
    },
    {
      id: "cd_jiuyanqiao_long_island_iced_tea",
      name: "九眼桥长岛冰茶",
      unitPrice: 100,
      unit: "杯",
      text: "够你在九眼桥喝 {count} 杯长岛冰茶。前司已经下头，长岛冰茶负责上头。",
      tier: "mid",
      tags: ["cocktail", "long_island_iced_tea", "jiuyanqiao"]
    },
    {
      id: "cd_yulin_mojito",
      name: "玉林莫吉托",
      unitPrice: 90,
      unit: "杯",
      text: "够你在玉林喝 {count} 杯莫吉托。班味退、退、退！薄荷续、续、续。",
      tier: "mid",
      tags: ["cocktail", "mojito", "yulin"]
    },
    {
      id: "cd_wangping_gin_tonic",
      name: "望平街金汤力",
      unitPrice: 90,
      unit: "杯",
      text: "够你在望平街喝 {count} 杯金汤力。班可以不上，气泡必须上头。",
      tier: "mid",
      tags: ["cocktail", "gin_tonic", "wangping_street"]
    },
    {
      id: "cd_lan_kwai_fong_shot",
      name: "兰桂坊 Shot",
      unitPrice: 50,
      unit: "杯",
      text: "够你在兰桂坊喝 {count} 杯 Shot。一口送走一个破需求。",
      tier: "low",
      tags: ["shot", "nightlife", "lan_kwai_fong"]
    }
  ],
  xian: [
    {
      id: "xa_qujiang_champagne",
      name: "曲江香槟",
      unitPrice: 180,
      unit: "杯",
      text: "够你在曲江喝 {count} 杯香槟。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["champagne", "rooftop", "qujiang"]
    },
    {
      id: "xa_southgate_martini",
      name: "南门马天尼",
      unitPrice: 110,
      unit: "杯",
      text: "够你在南门喝 {count} 杯马天尼。工牌一丢，腔调上桌。",
      tier: "mid",
      tags: ["cocktail", "martini", "south_gate"]
    },
    {
      id: "xa_defu_lane_long_island_iced_tea",
      name: "德福巷长岛冰茶",
      unitPrice: 100,
      unit: "杯",
      text: "够你在德福巷喝 {count} 杯长岛冰茶。前司已经下头，长岛冰茶负责上头。",
      tier: "mid",
      tags: ["cocktail", "long_island_iced_tea", "defu_lane"]
    },
    {
      id: "xa_liuyuan_mojito",
      name: "护城河边莫吉托",
      unitPrice: 90,
      unit: "杯",
      text: "够你在护城河边喝 {count} 杯莫吉托。晚风一吹，班味随风消散。",
      tier: "mid",
      tags: ["cocktail", "mojito", "liuyuan"]
    },
    {
      id: "xa_shuncheng_lane_shot",
      name: "顺城巷 Shot",
      unitPrice: 50,
      unit: "杯",
      text: "够你在顺城巷喝 {count} 杯 Shot。一口送走一个破需求。",
      tier: "low",
      tags: ["shot", "nightlife", "shuncheng_lane"]
    }
  ],
  other: [
    {
      id: "other_cbd_champagne",
      name: "本地 CBD 云端香槟",
      unitPrice: 180,
      unit: "杯",
      text: "够你在本地 CBD 喝 {count} 杯香槟。以前向上汇报，今晚向上举杯。",
      tier: "high",
      tags: ["champagne", "rooftop", "cbd"]
    },
    {
      id: "other_riverside_mojito",
      name: "莫吉托",
      unitPrice: 90,
      unit: "杯",
      text: "够你喝 {count} 杯莫吉托。晚风一吹，班味随风消散。",
      tier: "mid",
      tags: ["cocktail", "mojito", "riverside"]
    },
    {
      id: "other_old_town_long_island_iced_tea",
      name: "长岛冰茶",
      unitPrice: 100,
      unit: "杯",
      text: "够你喝 {count} 杯长岛冰茶。前司已经下头，长岛冰茶负责上头。",
      tier: "mid",
      tags: ["cocktail", "long_island_iced_tea", "old_town"]
    },
    {
      id: "other_trendy_district_martini",
      name: "马天尼",
      unitPrice: 110,
      unit: "杯",
      text: "够你喝 {count} 杯马天尼。工牌一丢，腔调上桌。",
      tier: "mid",
      tags: ["cocktail", "martini", "trendy_district"]
    },
    {
      id: "other_nightlife_shot",
      name: "夜场 Shot",
      unitPrice: 50,
      unit: "杯",
      text: "够你在夜场喝 {count} 杯 Shot。一口送走一个破需求。",
      tier: "low",
      tags: ["shot", "nightlife"]
    }
  ]
};

export const drinkEquivalentConfig = makeCityConfig("drink_for_freedom", "喝点好的", drinkSeedsByCity);

// 4. 宅家躺到爽。
export const homeEquivalents = makeItems("home_chill", "宅家回血", [
  {
    id: "smart_toilet", 
    name: "智能马桶", 
    unitPrice: 4000, 
    unit: "台",
    text: "够你换 {count} 台智能马桶。工位没坐明白，家里的宝座一步到位。", 
    tier: "high", 
    tags: ["bathroom", "appliance"]
  },
  {
    id: "thermostatic_shower", 
    name: "恒温花洒", 
    unitPrice: 1500, 
    unit: "套",
    text: "够你装 {count} 套恒温花洒。领导的态度忽冷忽热，洗澡水永远热乎。", 
    tier: "mid", 
    tags: ["bathroom", "comfort"]
  },
  {
    id: "double_door_fridge", 
    name: "双开门大冰箱", 
    unitPrice: 6000, 
    unit: "台",
    text: "够你买 {count} 台双开门大冰箱。以前给公司囤方案，现在给自己囤快乐水。", 
    tier: "high", 
    tags: ["kitchen", "appliance"]
  },
  {
    id: "air_fryer", 
    name: "空气炸锅", 
    unitPrice: 500, 
    unit: "台",
    text: "够你买 {count} 台空气炸锅。再也没有DDL，只有烤鸡翅倒计时。", 
    tier: "low", 
    tags: ["kitchen", "appliance"]
  },
  {
    id: "automatic_coffee_machine", 
    name: "全自动咖啡机", 
    unitPrice: 4000, 
    unit: "台",
    text: "够你买 {count} 台全自动咖啡机。咖啡慢慢喝，早会免了。", 
    tier: "high", 
    tags: ["coffee", "appliance"]
  },
  {
    id: "electric_massage_chair", 
    name: "电动按摩椅", 
    unitPrice: 8000, 
    unit: "台",
    text: "够你买 {count} 台电动按摩椅。以前被老板拿捏，现在按摩椅拿捏你。", 
    tier: "high", 
    tags: ["relaxation", "furniture"]
  },
  {
    id: "down_duvet", 
    name: "羽绒被", 
    unitPrice: 1200, 
    unit: "床",
    text: "够你买 {count} 床羽绒被。前司冷冰冰，被窝热乎乎。", 
    tier: "mid", 
    tags: ["sleep", "bedding"]
  },
  {
    id: "steam_aaa_game", 
    name: "Steam 3A 游戏", 
    unitPrice: 300, 
    unit: "款",
    text: "够你买 {count} 款 Steam 3A 游戏。需求池清空，愿望单结算。", 
    tier: "low", 
    tags: ["gaming", "pc_game"]
  },
  {
    id: "bean_bag_sofa", 
    name: "懒人沙发", 
    unitPrice: 1200, 
    unit: "个",
    text: "够你买 {count} 个懒人沙发。以前在工位端坐，现在想瘫多歪就多歪。", 
    tier: "mid", 
    tags: ["relaxation", "furniture"]
  },
  {
    id: "nintendo_switch", 
    name: "Nintendo Switch", 
    unitPrice: 2200, 
    unit: "台",
    text: "够你买 {count} 台 Nintendo Switch。撤离工位岛，登陆动森岛。", 
    tier: "mid", 
    tags: ["gaming", "console"]
  },
  {
    id: "ps5_console", 
    name: "PS5 游戏主机", 
    unitPrice: 3600, 
    unit: "台",
    text: "够你买 {count} 台 PS5。公司的主线任务结束，自己的存档继续。", 
    tier: "high", 
    tags: ["gaming", "console"]
  },
  {
    id: "tencent_video_vip", 
    name: "腾讯视频 VIP", 
    unitPrice: 198, 
    unit: "年",
    text: "够你开 {count} 年腾讯视频 VIP。不用上班，终于能查清收藏夹里那 286 部剧谁是凶手。", 
    tier: "low", 
    tags: ["streaming", "membership"]
  },
  {
    id: "bilibili_annual_membership", 
    name: "B站年度大会员", 
    unitPrice: 168, 
    unit: "年",
    text: "够你开 {count} 年B站大会员。周报停更，追番开始连载。", 
    tier: "low", 
    tags: ["streaming", "membership"]
  }
]);

// 5. 练出新肉身：每个城市单独配置，不通过共享模板生成。
export const gymEquivalentConfig = makeCityConfig("gym_rebuild", "练出新肉身", {
  beijing: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 500,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "bj_guomao_gym_card",
      name: "国贸健身房月卡",
      unitPrice: 1200,
      unit: "个月",
      text: "够你在国贸办 {count} 个月健身房月卡。以前在 CBD 挨打，现在在 CBD 练打。",
      tier: "high",
      tags: ["gym", "monthly_card", "cbd"]
    },
    {
      id: "bj_sanlitun_boxing",
      name: "三里屯拳击课",
      unitPrice: 300,
      unit: "节",
      text: "够你在三里屯上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "bj_running_shoes",
      name: "专业跑鞋",
      unitPrice: 1000,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。去奥森尽情跑步吧！终于不用一边跑步，一边挂念工作群。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  shanghai: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 500,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "sh_lujiazui_gym_card",
      name: "陆家嘴健身房月卡",
      unitPrice: 1500,
      unit: "个月",
      text: "够你在陆家嘴办 {count} 个月健身房月卡。以前在 CBD 卷业绩，现在在 CBD 卷腹。",
      tier: "high",
      tags: ["gym", "monthly_card", "cbd"]
    },
    {
      id: "sh_jingan_boxing",
      name: "静安拳击课",
      unitPrice: 260,
      unit: "节",
      text: "够你在静安上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "sh_anfuroad_pilates",
      name: "安福路普拉提",
      unitPrice: 260,
      unit: "节",
      text: "够你在安福路上 {count} 节普拉提课。离职可以狼狈，体态不能塌。",
      tier: "mid",
      tags: ["pilates", "class"]
    },
    {
      id: "sh_running_shoes",
      name: "专业跑鞋",
      unitPrice: 900,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。去苏州河畔跑掉班味！再也不用担心弹出工作消息。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "sh_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司已经是过去式，去徐汇滨江一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  guangzhou: [
    {
      id: "gz_zhujiangnewtown_gym_card",
      name: "珠江新城健身房月卡",
      unitPrice: 600,
      unit: "个月",
      text: "够你在珠江新城办 {count} 个月健身房月卡。离职后每天都能看到八块腹肌的健身教练，岂不美哉。",
      tier: "high",
      tags: ["gym", "monthly_card", "cbd"]
    },
    {
      id: "gz_tianhe_boxing",
      name: "天河拳击课",
      unitPrice: 200,
      unit: "节",
      text: "够你在天河上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "gz_running_shoes",
      name: "专业跑鞋",
      unitPrice: 900,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。终于可以退出工作群，去二沙岛夜跑。妈妈再也不用担心我边看手机边跑步。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "gz_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司已经是过去式，去大学城环岛一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  shenzhen: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 300,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "sz_futian_cbd_gym_card",
      name: "福田 CBD 健身房月卡",
      unitPrice: 1000,
      unit: "个月",
      text: "够你在福田 CBD 办 {count} 个月健身房月卡。以前在 CBD 卷工位，现在在 CBD 卷腹。",
      tier: "high",
      tags: ["gym", "monthly_card", "cbd"]
    },
    {
      id: "sz_nanshan_boxing",
      name: "南山拳击课",
      unitPrice: 240,
      unit: "节",
      text: "够你在南山上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "sz_mixcworld_pilates",
      name: "万象天地普拉提",
      unitPrice: 260,
      unit: "节",
      text: "够你在万象天地上 {count} 节普拉提课。离职可以狼狈，体态不能塌。",
      tier: "mid",
      tags: ["pilates", "class"]
    },
    {
      id: "sz_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司已经是过去式，去深圳湾公园一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  hangzhou: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 300,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "hz_wulin_boxing",
      name: "武林拳击课",
      unitPrice: 220,
      unit: "节",
      text: "够你在武林上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "hz_tianmuli_pilates",
      name: "天目里普拉提",
      unitPrice: 240,
      unit: "节",
      text: "够你在天目里上 {count} 节普拉提课。离职可以狼狈，体态不能塌。",
      tier: "mid",
      tags: ["pilates", "class"]
    },
    {
      id: "hz_running_shoes",
      name: "专业跑鞋",
      unitPrice: 900,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。终于可以退出工作群，去西湖边把班味跑掉。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "hz_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司已经是过去式，去钱塘江绿道一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  wuhan: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 300,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "wh_opticsvalley_boxing",
      name: "光谷拳击课",
      unitPrice: 180,
      unit: "节",
      text: "够你在光谷上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "wh_chuhehanstreet_pilates",
      name: "楚河汉街普拉提",
      unitPrice: 200,
      unit: "节",
      text: "够你在楚河汉街上 {count} 节普拉提课。离职可以狼狈，体态不能塌。",
      tier: "mid",
      tags: ["pilates", "class"]
    },
    {
      id: "wh_running_shoes",
      name: "专业跑鞋",
      unitPrice: 900,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。去汉口江滩把班味跑掉！再也不用担心工作群弹出新消息。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "wh_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司已经是过去式，去东湖绿道一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  chengdu: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 300,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "cd_financialcity_gym_card",
      name: "金融城健身房月卡",
      unitPrice: 800,
      unit: "个月",
      text: "够你在金融城办 {count} 个月健身房月卡。终于不用在金融城卷简历，现在我要卷腹！",
      tier: "high",
      tags: ["gym", "monthly_card", "cbd"]
    },
    {
      id: "cd_taikooli_boxing",
      name: "太古里拳击课",
      unitPrice: 220,
      unit: "节",
      text: "够你在太古里上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "cd_tongzilin_pilates",
      name: "桐梓林普拉提",
      unitPrice: 220,
      unit: "节",
      text: "够你在桐梓林上 {count} 节普拉提课。离职可以狼狈，体态不能塌。",
      tier: "mid",
      tags: ["pilates", "class"]
    },
    {
      id: "cd_running_shoes",
      name: "专业跑鞋",
      unitPrice: 900,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。去锦江绿道把班味跑掉！再也不用担心工作群弹出新消息。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "cd_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司留在后视镜，去天府绿道一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  xian: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 300,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "xa_gaoxin_gym_card",
      name: "高新 CBD 健身房月卡",
      unitPrice: 600,
      unit: "个月",
      text: "够你在高新 CBD 办 {count} 个月健身房月卡。班味留在写字楼，肌肉带回家。",
      tier: "high",
      tags: ["gym", "monthly_card", "cbd"]
    },
    {
      id: "xa_qujiang_boxing",
      name: "曲江拳击课",
      unitPrice: 180,
      unit: "节",
      text: "够你在曲江上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "xa_skp_pilates",
      name: "西安 SKP 普拉提",
      unitPrice: 220,
      unit: "节",
      text: "够你在西安 SKP 上 {count} 节普拉提课。离职可以狼狈，体态不能塌。",
      tier: "mid",
      tags: ["pilates", "class"]
    },
    {
      id: "xa_running_shoes",
      name: "专业跑鞋",
      unitPrice: 900,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。终于可以退出工作群，去西安城墙根把班味跑掉。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "xa_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司留在后视镜，去浐灞河畔一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ],
  other: [
    {
      id: "eight_pack_personal_trainer",
      name: "健身私教课",
      unitPrice: 300,
      unit: "天",
      text: "够你连上 {count} 天健身私教课。和八块腹肌的健身教练“亲密接触” {monthsAtOnePerDay} 个月。",
      tier: "mid",
      tags: ["personal_training"]
    },
    {
      id: "other_gym_card",
      name: "健身房月卡",
      unitPrice: 600,
      unit: "个月",
      text: "够你办 {count} 个月健身房月卡。以前卷工作，现在卷身材。",
      tier: "high",
      tags: ["gym", "monthly_card"]
    },
    {
      id: "other_boxing",
      name: "拳击课",
      unitPrice: 200,
      unit: "节",
      text: "够你上 {count} 节拳击课。这么多节课，够你苦练身手日后暴打老板了。",
      tier: "mid",
      tags: ["boxing", "class"]
    },
    {
      id: "other_pilates",
      name: "普拉提课",
      unitPrice: 200,
      unit: "节",
      text: "够你上 {count} 节普拉提课。离职可以狼狈，体态不能塌。",
      tier: "mid",
      tags: ["pilates", "class"]
    },
    {
      id: "other_running_shoes",
      name: "专业跑鞋",
      unitPrice: 900,
      unit: "双",
      text: "够你跑坏 {count} 双专业跑鞋。终于可以退出工作群，妈妈再也不用担心我边看手机边跑步。",
      tier: "mid",
      tags: ["running", "shoes"]
    },
    {
      id: "other_road_bike",
      name: "公路自行车",
      unitPrice: 3500,
      unit: "辆",
      text: "够你买 {count} 辆自行车，换着骑。前司留在后视镜，去城市绿道一路骑到心情放晴。",
      tier: "high",
      tags: ["cycling", "bike"]
    },
    {
      id: "on_gold_whey_protein",
      name: "ON 金牌乳清蛋白粉",
      unitPrice: 350,
      unit: "桶",
      text: "够你买 {count} 桶 ON 蛋白粉。公司不给成长机会，先让肌肉长起来吧！",
      tier: "mid",
      tags: ["protein", "supplement"]
    },
    {
      id: "yunmai_massage_gun",
      name: "云麦筋膜枪",
      unitPrice: 400,
      unit: "把",
      text: "够你买 {count} 把云麦筋膜枪。健身之余记得放松，为日后暴打老板做好万全准备！",
      tier: "mid",
      tags: ["recovery", "massage_gun"]
    },
    {
      id: "sports_watch_apple_watch",
      name: "Apple Watch",
      unitPrice: 2900,
      unit: "块",
      text: "够你买 {count} 块 Apple Watch。老板没记录你的付出，手表会。",
      tier: "high",
      tags: ["sports_watch", "wearable"]
    }
  ]
});

// 6. 去看看世界。
export const travelEquivalents = makeItems("see_the_world", "去看看世界", [
  {
    id: "iceland_glass_igloo_night",
    name: "冰岛极光之旅",
    unitPrice: 32000,
    unit: "趟",
    text: "够你去 {count} 趟冰岛。住进玻璃屋，静待极光，客户什么的下辈子再说。",
    tier: "high",
    tags: ["iceland", "aurora", "travel"]
  },
  {
    id: "paris_michelin_dinner",
    name: "法国巴黎之旅",
    unitPrice: 25000,
    unit: "趟",
    text: "够你去 {count} 趟法国巴黎。逛完塞纳河就去吃鹅肝，以前吞委屈，现在嚼嚼嚼~",
    tier: "high",
    tags: ["paris", "michelin", "travel"]
  },
  {
    id: "tokyo_omakase",
    name: "东京之旅",
    unitPrice: 15000,
    unit: "趟",
    text: "够你去 {count} 趟东京。把晚上的时间交给 omakase 主厨，再也别献给老板。",
    tier: "high",
    tags: ["tokyo", "omakase", "travel"]
  },
  {
    id: "broadway_musical",
    name: "纽约都市漫游之旅",
    unitPrice: 40000,
    unit: "趟",
    text: "够你去 {count} 趟纽约。我要逃离工位！我要去时代广场唱 Welcome to NewYork~",
    tier: "high",
    tags: ["new_york", "city", "travel"]
  },
  {
    id: "premier_league_match",
    name: "英国漫游之旅",
    unitPrice: 28000,
    unit: "趟",
    text: "够你去 {count} 趟英国。我不要在公司淋雨了，我宁愿去伦敦淋雨。",
    tier: "high",
    tags: ["uk", "city", "travel"]
  },
  {
    id: "cappadocia_hot_air_balloon",
    name: "土耳其热气球之旅",
    unitPrice: 15000,
    unit: "趟",
    text: "够你去 {count} 趟土耳其。热气球一升空，那个破工作缩成一个点。",
    tier: "high",
    tags: ["turkey", "hot_air_balloon", "travel"]
  },
  {
    id: "african_savanna_game_drive",
    name: "东非草原 Safari 之旅",
    unitPrice: 40000,
    unit: "趟",
    text: "够你去 {count} 趟东非草原。从工位到草原，这次同事是狮子~",
    tier: "high",
    tags: ["africa", "savanna", "safari", "travel"]
  },
  {
    id: "bali_surfing_lesson",
    name: "巴厘岛躺平之旅",
    unitPrice: 12000,
    unit: "趟",
    text: "够你去 {count} 趟巴厘岛。谁爱卷谁卷，老娘（老子）要在海边躺下了。",
    tier: "high",
    tags: ["bali", "island", "travel"]
  },
  {
    id: "swiss_ski_lesson",
    name: "瑞士雪山之旅",
    unitPrice: 35000,
    unit: "趟",
    text: "够你去 {count} 趟瑞士。去滑雪吧，直接把职场赛道换雪道！",
    tier: "high",
    tags: ["switzerland", "skiing", "travel"]
  },
  {
    id: "italy_round_trip_flight",
    name: "意大利漫游之旅",
    unitPrice: 22000,
    unit: "趟",
    text: "够你去 {count} 趟意大利。罗马、佛罗伦萨和威尼斯一路逛过去。我不在意那份工作了，我在意大利。",
    tier: "high",
    tags: ["italy", "flight", "travel"]
  }
]);

// 7. 给自己装备升级。
export const upgradeEquivalents = makeItems("self_upgrade", "装备升级", [
  {
    id: "rtx_5090_d_v2",
    name: "RTX 5090 显卡",
    unitPrice: 16500,
    unit: "张",
    text: "够你买 {count} 张 RTX 5090 显卡。白天学新技能，晚上开全画质奖励一下自己。",
    tier: "high",
    tags: ["gpu", "computer"]
  },
  {
    id: "macbook_pro",
    name: "MacBook Pro",
    unitPrice: 18000,
    unit: "台",
    text: "够你买 {count} 台 MacBook Pro。上一段安卓工作不堪回首，下一次我要在职场做苹果人",
    tier: "high",
    tags: ["laptop", "computer"]
  },
  {
    id: "apple_studio_display",
    name: "苹果 5K 显示器",
    unitPrice: 12000,
    unit: "台",
    text: "够你买 {count} 台苹果 5K 显示器。左边放网课，右边做练习，我的事业运能不能来一下。",
    tier: "high",
    tags: ["monitor", "computer", "apple"]
  },
  {
    id: "ergonomic_chair",
    name: "人体工学椅",
    unitPrice: 3000,
    unit: "把",
    text: "够你买 {count} 把人体工学椅。坐舒服了再学，下一份工作跑不了。",
    tier: "mid",
    tags: ["chair", "office"]
  },
  {
    id: "portable_ssd",
    name: "移动固态硬盘",
    unitPrice: 1000,
    unit: "块",
    text: "够你买 {count} 块移动固态硬盘。项目经历、简历、作品集都进去吧，入住1TB豪华房。",
    tier: "mid",
    tags: ["storage", "computer"]
  },
  {
    id: "logitech_mechanical_keyboard",
    name: "罗技机械键盘",
    unitPrice: 800,
    unit: "个",
    text: "够你买 {count} 个罗技机械键盘。写简历、练代码、投岗位，我即将崛起！",
    tier: "mid",
    tags: ["keyboard", "computer"]
  },
  {
    id: "chatgpt_plus",
    name: "ChatGPT Plus",
    unitPrice: 150,
    unit: "月",
    text: "够你开 {count} 个月 ChatGPT Plus。终于等到你~我的高精力学习搭子。",
    tier: "low",
    tags: ["ai", "subscription"]
  },
  {
    id: "claude_pro",
    name: "Claude Pro",
    unitPrice: 150,
    unit: "月",
    text: "够你开 {count} 个月 Claude Pro。长上下文一开，可以从第一版简历一直聊到 Offer 落袋。",
    tier: "low",
    tags: ["ai", "subscription"]
  }
]);

// 8. 这次自己当老板。
export const startupEquivalents = makeItems("be_your_own_boss", "自己当老板", [
  {
    id: "domain_name",
    name: "域名",
    unitPrice: 100,
    unit: "年",
    text: "够你续 {count} 年域名。先把喜欢的网址抢下来，这一次，我一定要拿到我想要的一切！",
    tier: "low",
    tags: ["domain", "website"]
  },
  {
    id: "cloud_server",
    name: "云服务器",
    unitPrice: 2000,
    unit: "年",
    text: "够你租 {count} 年云服务器。服务器全年待命，创业人的第一位电子员工正式上岗。",
    tier: "mid",
    tags: ["server", "cloud"]
  },
  {
    id: "chatgpt_plus",
    name: "ChatGPT Plus",
    unitPrice: 160,
    unit: "个月",
    text: "够你开 {count} 个月 ChatGPT Plus。一人公司正式扩编，文案、策划、客服新增一位共享员工。",
    tier: "low",
    tags: ["ai", "subscription"]
  },
  {
    id: "claude_pro",
    name: "Claude Pro",
    unitPrice: 160,
    unit: "个月",
    text: "够你开 {count} 个月 Claude Pro。商业计划书越写越长，总算来了个能从第一页跟到最后一页的搭子。",
    tier: "low",
    tags: ["ai", "subscription"]
  },
  {
    id: "macbook_pro",
    name: "MacBook Pro",
    unitPrice: 16000,
    unit: "台",
    text: "够你买 {count} 台 MacBook Pro。开机声一响，你和新公司同时进入筹备期。",
    tier: "high",
    tags: ["laptop", "computer"]
  },
  {
    id: "independent_office",
    name: "独立办公室",
    unitPrice: 10000,
    unit: "个月",
    text: "够你租 {count} 个月独立办公室。钥匙一拿，门口就差块“董事长办公室”的牌子了。",
    tier: "high",
    tags: ["office", "coworking"]
  },
  {
    id: "mvp_development",
    name: "MVP 开发",
    unitPrice: 20000,
    unit: "版",
    text: "够你做 {count} 版 MVP。发布按钮一按，从此用户们是我的新老板。",
    tier: "high",
    tags: ["mvp", "development"]
  },
  {
    id: "prototype_design",
    name: "产品原型设计",
    unitPrice: 8000,
    unit: "套",
    text: "够你做 {count} 套产品原型。拖拖拽拽一下午，价值千万的产品已经会点了。",
    tier: "high",
    tags: ["prototype", "design"]
  }
]);

const cityKeyByName: Array<[string, CityKey]> = [
  ["北京", "beijing"],
  ["上海", "shanghai"],
  ["广州", "guangzhou"],
  ["深圳", "shenzhen"],
  ["杭州", "hangzhou"],
  ["武汉", "wuhan"],
  ["成都", "chengdu"],
  ["西安", "xian"]
];

export type WishFantasyId =
  | "food_feast"
  | "go_have_fun"
  | "drink_for_freedom"
  | "home_chill"
  | "gym_rebuild"
  | "see_the_world"
  | "self_upgrade"
  | "be_your_own_boss";

export const getFantasyId = (wish?: string): WishFantasyId => {
  const value = wish || "";
  if (/先.*吃|大吃特吃/.test(value)) return "food_feast";
  if (/去喝|喝酒|酒吧|庆祝|消愁|fancy.*bar/i.test(value)) return "drink_for_freedom";
  if (/出门.*痛快|迪士尼|演唱会/.test(value)) return "go_have_fun";
  if (/宅家|追剧|打游戏/.test(value)) return "home_chill";
  if (/练出新肉身|健身|暴打/.test(value)) return "gym_rebuild";
  if (/看看世界|海岛|躺平|旅行/.test(value)) return "see_the_world";
  if (/自己当老板|创业/.test(value)) return "be_your_own_boss";
  return "self_upgrade";
};

const getCityKey = (city?: string): CityKey =>
  cityKeyByName.find(([name]) => (city || "").includes(name))?.[1] || "other";

export const getWishEquivalentPool = (wish?: string, city?: string): WishEquivalentItem[] => {
  const fantasyId = getFantasyId(wish);
  const cityKey = getCityKey(city);

  switch (fantasyId) {
    case "food_feast":
      return foodEquivalentConfig[cityKey];
    case "go_have_fun":
      return funEquivalentConfig[cityKey];
    case "drink_for_freedom":
      return drinkEquivalentConfig[cityKey];
    case "home_chill":
      return homeEquivalents;
    case "gym_rebuild":
      return gymEquivalentConfig[cityKey];
    case "see_the_world":
      return travelEquivalents;
    case "be_your_own_boss":
      return startupEquivalents;
    case "self_upgrade":
    default:
      return upgradeEquivalents;
  }
};
