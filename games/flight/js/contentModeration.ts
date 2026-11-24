







let bannedWordRegexes: RegExp[] = [];
let loadPromise: Promise<void> | null = null;

function escapeRegex(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskText(input: unknown) {
    if (input == null) return '';
    let text = String(input);
    if (!text || bannedWordRegexes.length === 0) return text;

    for (const regex of bannedWordRegexes) {
        text = text.replace(regex, (match) => '*'.repeat(match.length));
    }
    return text;
}

async function loadBannedWords() {
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        try {
            const words = Array.from(
                new Set(__FLIGHT_BANNED_WORDS__)
            ).sort((a, b) => b.length - a.length);

            bannedWordRegexes = words.map((word) => new RegExp(escapeRegex(word), 'gi'));
        } catch (error) {
            console.warn('[内容过滤] 违规词库加载失败，将跳过前端过滤:', error);
            bannedWordRegexes = [];
        }
    })();

    return loadPromise;
}

export async function sanitizeUserText(text: string) {
    await loadBannedWords();
    return maskText(text);
}
