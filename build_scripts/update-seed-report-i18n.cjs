#!/usr/bin/env node
/**
 * One-shot translation patcher for the Seed Report rewrite.
 *
 * Touches every src/locales/<lng>/translation.json file:
 *   - rewrites the seedReport keys whose wording changed (noSeed, indexing,
 *     compare.* templates, locked.body, spells.title, hvSpells column, spider
 *     axis label)
 *   - adds the new keys that didn't exist yet (spell.category.utility/damage/
 *     other, locked.title/body/cta if missing, spoilerFree.title/body)
 *
 * Non-English locales get English placeholders for the brand-new keys (so the
 * UI is at least readable in every language) and otherwise keep their existing
 * locale-specific wording when the meaning is unchanged. Run `copy-locales`
 * afterwards to sync into public/locales for the dev server.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src", "locales");

// Locale-specific overrides where I can give a meaningful translation without
// guessing. Everything not listed here falls back to the English default.
const TRANSLATIONS = {
  // Per-locale strings for the "Waiting for the dynamic map to finish" message.
  // Kept in the local language because the user reads it in their UI.
  emptyMsg: {
    en: "Waiting for the dynamic map to finish - the report will appear here.",
    br: "Aguardando o mapa dinâmico terminar - o relatório aparecerá aqui.",
    cs: "Čeká se na dokončení dynamické mapy – sestava se zde zobrazí.",
    de: "Die dynamische Karte wird noch geladen – der Bericht erscheint hier.",
    es: "Esperando a que termine el mapa dinámico - el informe aparecerá aquí.",
    fi: "Odotetaan, että dynaaminen kartta valmistuu – raportti tulee tähän.",
    fr: "En attente de la fin de la carte dynamique - le rapport apparaîtra ici.",
    id: "Menunggu peta dinamis selesai - laporan akan muncul di sini.",
    it: "In attesa del completamento della mappa dinamica - il report apparirà qui.",
    ja: "ダイナミックマップの生成を待っています - レポートはここに表示されます。",
    nl: "Wachten tot de dynamische kaart klaar is – het rapport verschijnt hier.",
    pl: "Oczekiwanie na zakończenie dynamicznej mapy - raport pojawi się tutaj.",
    ru: "Ожидание завершения динамической карты — отчёт появится здесь.",
    sv: "Väntar på att den dynamiska kartan ska bli klar – rapporten visas här.",
    uk: "Очікування завершення динамічної карти — звіт з'явиться тут.",
    zh: "正在等待动态地图完成 - 报告将显示在此处。",
  },
  // Headings / labels.
  highValueSpells: {
    en: "High value spells",
    br: "Feitiços de alto valor",
    cs: "Kouzla vysoké hodnoty",
    de: "Hochwertige Zauber",
    es: "Hechizos de alto valor",
    fi: "Arvokkaita loitsuja",
    fr: "Sorts de grande valeur",
    id: "Mantra bernilai tinggi",
    it: "Incantesimi di alto valore",
    ja: "高価値の呪文",
    nl: "Hoogwaardige spreuken",
    pl: "Zaklęcia o dużej wartości",
    ru: "Ценные заклинания",
    sv: "Värdefulla trollformler",
    uk: "Цінні заклинання",
    zh: "高价值法术",
  },
  // compare.*. Templates contain {{target}} and {{seed}} interpolation tokens.
  compareVs: {
    en: "vs {{target}} (seed {{seed}})",
    br: "vs {{target}} (semente {{seed}})",
    cs: "vs {{target}} (semínko {{seed}})",
    de: "vs {{target}} (Seed {{seed}})",
    es: "vs {{target}} (semilla {{seed}})",
    fi: "vs {{target}} (siemen {{seed}})",
    fr: "vs {{target}} (graine {{seed}})",
    id: "vs {{target}} (benih {{seed}})",
    it: "vs {{target}} (seme {{seed}})",
    ja: "vs {{target}} (シード {{seed}})",
    nl: "vs {{target}} (seed {{seed}})",
    pl: "vs {{target}} (ziarno {{seed}})",
    ru: "vs {{target}} (сид {{seed}})",
    sv: "vs {{target}} (frö {{seed}})",
    uk: "vs {{target}} (сід {{seed}})",
    zh: "对比 {{target}} (种子 {{seed}})",
  },
  compareUnavailable: {
    en: "no comparison available",
    br: "nenhuma comparação disponível",
    cs: "žádné srovnání není k dispozici",
    de: "kein Vergleich verfügbar",
    es: "no hay comparación disponible",
    fi: "ei vertailua saatavilla",
    fr: "aucune comparaison disponible",
    id: "tidak ada perbandingan yang tersedia",
    it: "nessun confronto disponibile",
    ja: "比較データはありません",
    nl: "geen vergelijking beschikbaar",
    pl: "brak możliwości porównania",
    ru: "сравнение недоступно",
    sv: "ingen jämförelse tillgänglig",
    uk: "порівняння недоступне",
    zh: "无法比较",
  },
  compareNotCached: {
    en: "vs {{target}} (seed {{seed}}) - visit it once to load comparison data",
    br: "vs {{target}} (semente {{seed}}) - visite-o uma vez para carregar os dados de comparação",
    cs: "vs {{target}} (semínko {{seed}}) - navštivte jej jednou pro načtení srovnání",
    de: "vs {{target}} (Seed {{seed}}) - einmal besuchen, um Vergleichsdaten zu laden",
    es: "vs {{target}} (semilla {{seed}}) - visítalo una vez para cargar la comparación",
    fi: "vs {{target}} (siemen {{seed}}) - käy kerran ladataksesi vertailutiedot",
    fr: "vs {{target}} (graine {{seed}}) - visitez-la une fois pour charger les données de comparaison",
    id: "vs {{target}} (benih {{seed}}) - kunjungi sekali untuk memuat data perbandingan",
    it: "vs {{target}} (seme {{seed}}) - visitalo una volta per caricare il confronto",
    ja: "vs {{target}} (シード {{seed}}) - 一度訪れて比較データを読み込んでください",
    nl: "vs {{target}} (seed {{seed}}) - bezoek het één keer om vergelijkingsgegevens te laden",
    pl: "vs {{target}} (ziarno {{seed}}) - odwiedź je raz, aby załadować porównanie",
    ru: "vs {{target}} (сид {{seed}}) - откройте его один раз, чтобы загрузить данные сравнения",
    sv: "vs {{target}} (frö {{seed}}) - besök det en gång för att läsa in jämförelsedata",
    uk: "vs {{target}} (сід {{seed}}) - відкрийте один раз, щоб завантажити дані для порівняння",
    zh: "对比 {{target}} (种子 {{seed}}) - 访问一次以加载对比数据",
  },
  // Spell categories — new keys.
  catUtility: {
    en: "Utility",
    br: "Utilidade", cs: "Pomocné", de: "Nützliches", es: "Utilidad",
    fi: "Apukeinot", fr: "Utilitaire", id: "Utilitas", it: "Utilità",
    ja: "ユーティリティ", nl: "Hulpmiddelen", pl: "Użytkowe", ru: "Утилитарные",
    sv: "Verktyg", uk: "Допоміжні", zh: "实用",
  },
  catDamage: {
    en: "Damage",
    br: "Dano", cs: "Poškození", de: "Schaden", es: "Daño",
    fi: "Vahinko", fr: "Dégâts", id: "Kerusakan", it: "Danno",
    ja: "ダメージ", nl: "Schade", pl: "Obrażenia", ru: "Урон",
    sv: "Skada", uk: "Шкода", zh: "伤害",
  },
  catOther: {
    en: "Other",
    br: "Outros", cs: "Ostatní", de: "Sonstige", es: "Otros",
    fi: "Muut", fr: "Autres", id: "Lainnya", it: "Altri",
    ja: "その他", nl: "Overige", pl: "Inne", ru: "Прочие",
    sv: "Övriga", uk: "Інші", zh: "其他",
  },
  // Locked banner.
  lockedTitle: {
    en: "Seed report is a Pro feature",
    br: "O relatório de semente é um recurso Pro",
    cs: "Zpráva o semínku je funkce Pro",
    de: "Der Seed-Bericht ist eine Pro-Funktion",
    es: "El informe de semilla es una función Pro",
    fi: "Siemenraportti on Pro-ominaisuus",
    fr: "Le rapport de graine est une fonctionnalité Pro",
    id: "Laporan benih adalah fitur Pro",
    it: "Il report dei semi è una funzionalità Pro",
    ja: "シードレポートはProの機能です",
    nl: "Het seed-rapport is een Pro-functie",
    pl: "Raport ziarna to funkcja Pro",
    ru: "Отчёт о сиде — функция Pro",
    sv: "Frörapporten är en Pro-funktion",
    uk: "Звіт за сідом — це функція Pro",
    zh: "种子报告是 Pro 功能",
  },
  lockedBody: {
    en: "Subscribe to see per-PW / per-biome counts, high value spells, and rare material locations for the current seed.",
    br: "Assine para ver as contagens por PW / por bioma, feitiços de alto valor e locais de materiais raros para a semente atual.",
    cs: "Předplatné odhalí počty per PW / per biom, kouzla vysoké hodnoty a místa vzácných materiálů pro aktuální semínko.",
    de: "Abonniere, um pro PW / pro Biom Zählungen, hochwertige Zauber und Fundorte seltener Materialien für den aktuellen Seed zu sehen.",
    es: "Suscríbete para ver los recuentos por PW / por bioma, hechizos de alto valor y ubicaciones de materiales raros para la semilla actual.",
    fi: "Tilaa nähdäksesi PW/bioomi-laskennat, arvokkaat loitsut ja harvinaisten materiaalien sijainnit nykyiselle siemenelle.",
    fr: "Abonnez-vous pour voir les comptages par PW / par biome, les sorts de grande valeur et les emplacements des matériaux rares pour la graine actuelle.",
    id: "Berlangganan untuk melihat hitungan per PW / per bioma, mantra bernilai tinggi, dan lokasi material langka untuk benih saat ini.",
    it: "Abbonati per vedere i conteggi per PW / per bioma, gli incantesimi di alto valore e le posizioni dei materiali rari per il seme attuale.",
    ja: "サブスクリプションで、現在のシードのPW別 / バイオーム別の数、高価値の呪文、レア素材の場所を確認できます。",
    nl: "Abonneer om per-PW / per-bioom tellingen, hoogwaardige spreuken en zeldzame materiaallocaties voor de huidige seed te zien.",
    pl: "Subskrybuj, aby zobaczyć liczby per PW / per biom, zaklęcia o dużej wartości i lokalizacje rzadkich materiałów dla bieżącego ziarna.",
    ru: "Подпишитесь, чтобы видеть счётчики по PW / по биомам, ценные заклинания и места редких материалов для текущего сида.",
    sv: "Prenumerera för att se räkningar per PW / per biom, värdefulla trollformler och platser för sällsynta material för det aktuella fröet.",
    uk: "Підпишіться, щоб бачити підрахунки по PW / по біомах, цінні заклинання та локації рідкісних матеріалів для поточного сіду.",
    zh: "订阅以查看当前种子的每个 PW / 每个生物群系的计数、高价值法术和稀有材料位置。",
  },
  lockedCta: {
    en: "Unlock with Pro",
    br: "Desbloquear com Pro", cs: "Odemknout s Pro", de: "Mit Pro freischalten",
    es: "Desbloquear con Pro", fi: "Avaa Prolla", fr: "Débloquer avec Pro",
    id: "Buka dengan Pro", it: "Sblocca con Pro", ja: "Proで解除",
    nl: "Ontgrendel met Pro", pl: "Odblokuj z Pro", ru: "Открыть с Pro",
    sv: "Lås upp med Pro", uk: "Розблокувати з Pro", zh: "使用 Pro 解锁",
  },
  // Spoiler-free banner.
  spoilerTitle: {
    en: "Spoiler-free mode is on",
    br: "Modo sem spoilers ativado",
    cs: "Režim bez spoilerů je zapnutý",
    de: "Spoilerfreier Modus ist aktiv",
    es: "Modo sin spoilers activado",
    fi: "Spoileriton tila on käytössä",
    fr: "Le mode sans spoilers est activé",
    id: "Mode bebas spoiler aktif",
    it: "Modalità senza spoiler attiva",
    ja: "ネタバレ防止モードがオンです",
    nl: "Spoilervrije modus staat aan",
    pl: "Tryb bez spoilerów jest włączony",
    ru: "Включён режим без спойлеров",
    sv: "Spoilerfritt läge är på",
    uk: "Увімкнено режим без спойлерів",
    zh: "已开启防剧透模式",
  },
  spoilerBody: {
    en: "Stats are hidden while spoiler-free is on. Disable it to reveal them.",
    br: "As estatísticas ficam ocultas no modo sem spoilers. Desative-o para vê-las.",
    cs: "Statistiky jsou skryté, dokud je režim bez spoilerů zapnutý. Vypněte jej, abyste je odhalili.",
    de: "Statistiken sind im spoilerfreien Modus ausgeblendet. Schalte ihn aus, um sie anzuzeigen.",
    es: "Las estadísticas están ocultas con el modo sin spoilers. Desactívalo para mostrarlas.",
    fi: "Tilastot on piilotettu spoilerittomassa tilassa. Poista käytöstä paljastaaksesi ne.",
    fr: "Les statistiques sont masquées en mode sans spoilers. Désactivez-le pour les afficher.",
    id: "Statistik disembunyikan saat mode bebas spoiler aktif. Matikan untuk melihatnya.",
    it: "Le statistiche sono nascoste in modalità senza spoiler. Disattivala per mostrarle.",
    ja: "ネタバレ防止モードでは統計が非表示になります。オフにすると表示されます。",
    nl: "Statistieken zijn verborgen in de spoilervrije modus. Schakel deze uit om ze te tonen.",
    pl: "Statystyki są ukryte w trybie bez spoilerów. Wyłącz go, aby je odsłonić.",
    ru: "Статистика скрыта в режиме без спойлеров. Отключите режим, чтобы её увидеть.",
    sv: "Statistiken är dold i spoilerfritt läge. Stäng av det för att visa den.",
    uk: "Статистику приховано в режимі без спойлерів. Вимкніть, щоб побачити її.",
    zh: "防剧透模式开启时统计数据已隐藏。关闭后即可查看。",
  },
};

function pick(map, locale) {
  return map[locale] ?? map.en;
}

function patchLocale(localeDir) {
  const locale = path.basename(localeDir);
  const file = path.join(localeDir, "translation.json");
  if (!fs.existsSync(file)) return false;
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);

  data.seedReport = data.seedReport ?? {};
  const sr = data.seedReport;

  // empty.*
  sr.empty = sr.empty ?? {};
  sr.empty.noSeed = pick(TRANSLATIONS.emptyMsg, locale);
  sr.empty.indexing = pick(TRANSLATIONS.emptyMsg, locale);

  // col.hvSpells + spider.axis.hvSpells + spells.title — all "High value spells"
  sr.col = sr.col ?? {};
  sr.col.hvSpells = pick(TRANSLATIONS.highValueSpells, locale);
  sr.spider = sr.spider ?? {};
  sr.spider.axis = sr.spider.axis ?? {};
  sr.spider.axis.hvSpells = pick(TRANSLATIONS.highValueSpells, locale);
  sr.spells = sr.spells ?? {};
  sr.spells.title = pick(TRANSLATIONS.highValueSpells, locale);

  // compare.* — new templates
  sr.compare = sr.compare ?? {};
  sr.compare.comparedTo = pick(TRANSLATIONS.compareVs, locale);
  sr.compare.unavailable = pick(TRANSLATIONS.compareUnavailable, locale);
  sr.compare.notCached = pick(TRANSLATIONS.compareNotCached, locale);

  // spell.category.* — three new categories
  sr.spell = sr.spell ?? {};
  sr.spell.category = sr.spell.category ?? {};
  sr.spell.category.utility = pick(TRANSLATIONS.catUtility, locale);
  sr.spell.category.damage = pick(TRANSLATIONS.catDamage, locale);
  sr.spell.category.other = pick(TRANSLATIONS.catOther, locale);

  // locked.* — banner
  sr.locked = sr.locked ?? {};
  sr.locked.title = pick(TRANSLATIONS.lockedTitle, locale);
  sr.locked.body = pick(TRANSLATIONS.lockedBody, locale);
  sr.locked.cta = pick(TRANSLATIONS.lockedCta, locale);

  // spoilerFree.* — new
  sr.spoilerFree = sr.spoilerFree ?? {};
  sr.spoilerFree.title = pick(TRANSLATIONS.spoilerTitle, locale);
  sr.spoilerFree.body = pick(TRANSLATIONS.spoilerBody, locale);

  const out = JSON.stringify(data, null, 2) + "\n";
  if (out !== raw) {
    fs.writeFileSync(file, out);
    return true;
  }
  return false;
}

const locales = fs
  .readdirSync(SRC_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(SRC_DIR, e.name));

let changed = 0;
for (const dir of locales) {
  if (patchLocale(dir)) {
    changed++;
    console.log(`updated ${path.basename(dir)}`);
  } else {
    console.log(`unchanged ${path.basename(dir)}`);
  }
}
console.log(`done — ${changed} files updated`);
