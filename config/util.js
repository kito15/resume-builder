const crypto = require('crypto');
const levenshtein = require('fast-levenshtein');

function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s]/g, '')
        .trim();
}

function generateHash(text) {
    const normalized = normalizeText(text);
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function calculateSimilarity(str1, str2) {
    const distance = levenshtein.get(str1, str2);
    return 1 - distance / Math.max(str1.length, str2.length);
}

function calculateKeywordSimilarity(setA, setB) {
    const a = new Set(setA);
    const b = new Set(setB);
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
}

module.exports = {
    normalizeText,
    generateHash,
    calculateSimilarity,
    calculateKeywordSimilarity
}; 
