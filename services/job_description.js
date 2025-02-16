// job_description.js
const { pool } = require('../config/db'); // Database connection
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util');

const MIN_KEYWORD_OVERLAP = 0.85; // 85% similarity

async function checkJobDescription(req, res) {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });

        // Server-side hashing
        const hash = generateHash(text);
        const normalizedText = normalizeText(text);
        const charLength = text.length;

        // First, try exact hash match
        const [exactMatches] = await pool.execute(
            'SELECT * FROM job_descriptions WHERE content_hash = ?',
            [hash]
        );

        if (exactMatches.length > 0) {
            const keywords = exactMatches[0].keywords; // Already parsed by MySQL driver
            
           // job_description.js  (Continued from previous response)
            if (!Array.isArray(keywords)) {
                console.error('Non-array keywords:', keywords);
                throw new Error('Invalid keyword format');
            }

            return res.json({
                found: true,
                keywords
            });
        }

        // NEW: Narrow the candidate set by ordering by closeness in char length and limiting the results
        const lengthMargin = Math.floor(charLength * 0.05);
        const [similarLengthEntries] = await pool.execute(
            `SELECT * FROM job_descriptions 
             WHERE char_length BETWEEN ? AND ? 
             ORDER BY ABS(char_length - ?) 
             LIMIT 10`,
            [charLength - lengthMargin, charLength + lengthMargin, charLength]
        );

        // Check for content similarity in a reduced candidate set
        for (const entry of similarLengthEntries) {
            const similarityScore = calculateSimilarity(normalizedText, entry.normalized_text);
            if (similarityScore >= 0.85) {
                // Use a separate variable name for keyword similarity
                const keywordSim = calculateKeywordSimilarity(entry.keywords, entry.keywords);
                if (keywordSim >= MIN_KEYWORD_OVERLAP) {
                    return res.json({
                        found: true,
                        keywords: entry.keywords
                    });
                }
            }
        }

        // No match found
        return res.json({ found: false });

    } catch (error) {
        console.error('Error checking job description:', error);
        res.status(500).json({
            error: error.message.startsWith('Corrupted')
                ? 'Server encountered invalid data - please try again'
                : 'Internal server error'
        });
    }
}



async function storeJobDescription(req, res) {
    // Immediately return success to the client
    res.json({ success: true });

    // Launch the storage operation asynchronously (fire-and-forget)
    (async () => {
        try {
            const { text, keywords } = req.body;

            // Server-side validation and hashing
            const hash = generateHash(text);
            const normalizedText = normalizeText(text);
            const charLength = text.length;

            // Validate keywords array
            if (!Array.isArray(keywords) || keywords.length < 3) {
                console.error('Invalid keywords - must contain at least 3 items');
                return;
            }

            // Clean keywords before storage
            const cleanKeywords = [...new Set(keywords)]
                .filter(k => k.length >= 3)
                .slice(0, 25);

            // Check if exact hash already exists
            const [existing] = await pool.execute(
                'SELECT id FROM job_descriptions WHERE content_hash = ?',
                [hash]
            );

            if (existing.length > 0) {
                // Update existing entry
                await pool.execute(
                    `UPDATE job_descriptions 
                    SET keywords = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE content_hash = ?`,
                    [JSON.stringify(cleanKeywords), hash]
                );
            } else {
                // Insert new entry
                await pool.execute(
                    `INSERT INTO job_descriptions 
                    (content_hash, full_text, keywords, char_length, normalized_text) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [hash, text, JSON.stringify(cleanKeywords), charLength, normalizedText]
                );
            }
        } catch (error) {
            console.error('Error storing job description:', error);
        }
    })();
}

module.exports = { checkJobDescription, storeJobDescription };
