import i18next from '../i18n';

class GameTranslator {
  // Method to translate spell names, item names, etc.
  translateGameContent(originalName: string): string {
    // Try to get translation from the current language's gameContent section
    const gameContentKey = `gameContent.spells.${originalName}`;
    const translated = i18next.t(gameContentKey, { defaultValue: null });

    if (translated && translated !== gameContentKey) {
      return translated;
    }

    // Fallback to original name
    return originalName;
  }

  private cache = new Map<string, string>();

  constructor() {
    i18next.on('languageChanged', () => {
      this.cache.clear();
    });
  }

  // Generic method for translating any game content type
  translateContent(contentType: string, originalName: string): string {
    const cacheKey = `${contentType}:${originalName}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Try to get translation from the current language's gameContent section
    const gameContentKey = `gameContent.${contentType}.${originalName}`;
    const translated = i18next.t(gameContentKey, { defaultValue: null });

    if (translated && translated !== gameContentKey) {
      this.cache.set(cacheKey, translated);
      return translated;
    }

    // Fallback: check "ui" category
    const uiKey = `gameContent.ui.${originalName}`;
    const uiTranslated = i18next.t(uiKey, { defaultValue: null });
    if (uiTranslated && uiTranslated !== uiKey) {
      this.cache.set(cacheKey, uiTranslated);
      return uiTranslated;
    }

    // Fallback: check lowercase versions
    const lowerName = originalName.toLowerCase();
    const categories = ['materials', 'items', 'spells', 'bosses', 'structures', 'ui'];
    for (const cat of categories) {
      const catKey = `gameContent.${cat}.${lowerName}`;
      const catTranslated = i18next.t(catKey, { defaultValue: null });
      if (catTranslated && catTranslated !== catKey) {
        this.cache.set(cacheKey, catTranslated);
        return catTranslated;
      }
    }

    // Fallback to original name
    this.cache.set(cacheKey, originalName);
    return originalName;
  }

  // Specific methods for different content types
  translateSpell(spellName: string): string {
    return this.translateContent('spells', spellName);
  }

  translateItem(itemName: string): string {
    return this.translateContent('items', itemName);
  }

  translateBoss(bossName: string): string {
    return this.translateContent('bosses', bossName);
  }

  translateStructure(structureName: string): string {
    return this.translateContent('structures', structureName);
  }

  translateMaterial(materialId: string): string {
    // If it's a tech name starting with mat_, strip it first (but process-translations.cjs already does this)
    const id = materialId.startsWith('mat_') ? materialId.replace('mat_', '') : materialId;
    return this.translateContent('materials', id);
  }
}

// Export singleton instance
export const gameTranslator = new GameTranslator();
