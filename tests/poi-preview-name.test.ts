import { beforeAll, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import en from "../src/locales/en/translation.json";
import ja from "../src/locales/ja/translation.json";
const { instance } = vi.hoisted(() => ({ instance: { current: null as any } }));
vi.mock("../src/i18n", () => ({
  default: new Proxy(
    {},
    {
      get(_target, prop) {
        const value = instance.current[prop];
        return typeof value === "function"
          ? value.bind(instance.current)
          : value;
      },
    },
  ),
}));
let getPOIDisplayName: typeof import("../src/telescope/poi-display-name").getPOIDisplayName;
beforeAll(async () => {
  instance.current = createInstance();
  await instance.current.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en }, ja: { translation: ja } },
  });
  ({ getPOIDisplayName } = await import("../src/telescope/poi-display-name"));
});
describe("canonical loot display names", () => {
  it.each([
    ["kammi", "Kammi"],
    ["kuu", "Kuu"],
    ["ukkoskivi", "Ukkoskivi"],
    ["kiuaskivi", "Kiuaskivi"],
    ["paha_silma", "Paha Silmä"],
    ["chaos_die", "Chaos die"],
  ])("translates %s through the real game key", (item, name) => {
    expect(getPOIDisplayName({ type: "item", item })).toBe(name);
  });
  it("preserves spell names, custom wand names, and material identity", () => {
    expect(
      getPOIDisplayName({ type: "item", item: "spell", spell: "NOLLA" }),
    ).toBe("Nolla");
    expect(getPOIDisplayName({ type: "wand", name: "Saha" })).toBe("Saha");
    expect(
      getPOIDisplayName({ type: "item", item: "potion", material: "ambrosia" }),
    ).toBe("Potion · Ambrosia");
    expect(getPOIDisplayName({ type: "chest", chestVariant: "coral" })).toBe(
      "Coral chest",
    );
  });
  it("uses the actual locale for Kammi instead of the raw generator id", async () => {
    await instance.current.changeLanguage("ja");
    expect(getPOIDisplayName({ type: "item", item: "kammi" })).toBe(
      ja.gameContent.ui.item_safe_haven,
    );
    await instance.current.changeLanguage("en");
  });
});
