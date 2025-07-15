import i18next from '../i18n';

class GameTranslator {
  // Method to translate spell names, item names, etc.
  translateGameContent(originalName: string): string {
    const currentLang = i18next.language;

    // For English, return as-is
    if (currentLang === 'en') {
      return originalName;
    }

    // Try to get translation from the current language's gameContent section
    const gameContentKey = `gameContent.spells.${originalName}`;
    const translated = i18next.t(gameContentKey, { defaultValue: null });

    if (translated && translated !== gameContentKey) {
      return translated;
    }

    // Fallback to original name
    return originalName;
  }

  // Generic method for translating any game content type
  translateContent(contentType: string, originalName: string): string {
    const currentLang = i18next.language;

    // For English, return as-is
    if (currentLang === 'en') {
      return originalName;
    }

    // Try to get translation from the current language's gameContent section
    const gameContentKey = `gameContent.${contentType}.${originalName}`;
    const translated = i18next.t(gameContentKey, { defaultValue: null });

    if (translated && translated !== gameContentKey) {
      return translated;
    }

    // Fallback to original name
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
}

// Export singleton instance
export const gameTranslator = new GameTranslator();
