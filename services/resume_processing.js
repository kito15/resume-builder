// resume_processing.js
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for Gemini
const geminiApiKey = process.env.GEMINI_API_KEY;
// Simple in-memory cache for LLM responses
const lmCache = new Map();


function countWordsInBullet(text) {
    // Remove extra whitespace and special characters
    const cleaned = text.trim()
        .replace(/[""]/g, '') // Remove smart quotes
        .replace(/[.,!?()]/g, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize spaces
    
    // Count hyphenated words as one word
    const words = cleaned.split(' ')
        .filter(word => word.length > 0)
        .map(word => word.replace(/-/g, '')); // Treat hyphenated words as single
        
    return words.length;
}

function getSectionWordCounts($) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Count job section bullets
    $('.job-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });

    // Count project section bullets
    $('.project-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });

    // Count education section bullets
    $('.education-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.education.total += wordCount;
        counts.education.bullets++;
    });

    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}

// Add new function to extract and store original bullets
function extractOriginalBullets($) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: [] // For any bullets not in a specific section
    };

    // Extract job bullets
    $('.job-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.job.includes(bulletText)) {
                originalBullets.job.push(bulletText);
            }
        });
    });

    // Extract project bullets
    $('.project-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.project.includes(bulletText)) {
                originalBullets.project.push(bulletText);
            }
        });
    });

    // Extract education bullets
    $('.education-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.education.includes(bulletText)) {
                originalBullets.education.push(bulletText);
            }
        });
    });

    return originalBullets;
}

// Add new class to track section-specific bullets
class SectionBulletTracker {
    constructor() {
        this.bulletMap = new Map(); // Maps bullet text to section type
        this.usedBullets = new Set(); // Tracks all used bullets
    }

    addBullet(bulletText, sectionType) {
        this.bulletMap.set(bulletText, sectionType);
        this.usedBullets.add(bulletText);
    }

    canUseBulletInSection(bulletText, sectionType) {
        // If bullet hasn't been used before, it can be used
        if (!this.bulletMap.has(bulletText)) return true;
        // If bullet has been used, only allow in same section type
        return this.bulletMap.get(bulletText) === sectionType;
    }

    isUsed(bulletText) {
        return this.usedBullets.has(bulletText);
    }
}

// Improve the ActionVerbTracker class to be more effective at preventing duplicate verbs
class ActionVerbTracker {
    constructor() {
        this.usedVerbs = new Map(); // Maps section type to Set of used verbs
        this.globalVerbs = new Set(); // Tracks verbs used across all sections
        this.verbSynonyms = new Map(); // Maps common verbs to their usage count
    }

    addVerb(verb, sectionType) {
        verb = verb.toLowerCase().trim();
        
        // Skip empty or non-word verbs
        if (!verb || !verb.match(/^[a-z]+$/)) return;
        
        if (!this.usedVerbs.has(sectionType)) {
            this.usedVerbs.set(sectionType, new Set());
        }
        this.usedVerbs.get(sectionType).add(verb);
        this.globalVerbs.add(verb);
        
        // Track verb usage frequency
        if (!this.verbSynonyms.has(verb)) {
            this.verbSynonyms.set(verb, 1);
        } else {
            this.verbSynonyms.set(verb, this.verbSynonyms.get(verb) + 1);
        }
    }

    isVerbUsedInSection(verb, sectionType) {
        verb = verb.toLowerCase().trim();
        return this.usedVerbs.get(sectionType)?.has(verb) || false;
    }

    isVerbUsedGlobally(verb) {
        verb = verb.toLowerCase().trim();
        return this.globalVerbs.has(verb);
    }

    getUsedVerbs() {
        return Array.from(this.globalVerbs);
    }

    getMostUsedVerbs(limit = 10) {
        // Return the most commonly used verbs to avoid
        return Array.from(this.verbSynonyms.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(entry => entry[0]);
    }

    clearSection(sectionType) {
        this.usedVerbs.set(sectionType, new Set());
    }
}

// Add function to get first verb from bullet point
function getFirstVerb(bulletText) {
    return bulletText.trim().split(/\s+/)[0].toLowerCase();
}

// Update the generateBullets function to emphasize verb diversity
async function generateBullets(mode, existingBullets, keywords, context, wordLimit, verbTracker) {
    let prompt;
    
    // Get previously used verbs to avoid
    const usedVerbs = verbTracker ? verbTracker.getUsedVerbs() : [];
    const mostUsedVerbs = verbTracker ? verbTracker.getMostUsedVerbs(8) : [];
    
    const verbAvoidanceText = usedVerbs.length > 0 
        ? `\nAVOID THESE PREVIOUSLY USED VERBS: ${usedVerbs.join(', ')}\n`
        : '';
        
    const mostUsedVerbsText = mostUsedVerbs.length > 0
        ? `ESPECIALLY AVOID THESE OVERUSED VERBS: ${mostUsedVerbs.join(', ')}`
        : '';

    const basePrompt = `Expert resume writer: Transform bullets into specific, measurable achievements using the STAR method.

CRITICAL FORMATTING REQUIREMENT (ABSOLUTE RULE):
Every single line representing a bullet point in your output MUST begin with exactly ">>" (two greater-than signs).
There must be absolutely NO characters or whitespace before the ">>".
Correct Example: ">>Developed..."
Incorrect Examples: " >>Developed...", " Developed...", "- Developed...", "Developed..."
This rule applies to ALL bullet points generated, without exception.

ACTION VERB REQUIREMENTS (HIGHEST PRIORITY):
1) Each bullet MUST start with a DIFFERENT professional action verb
2) STRICTLY PROHIBITED VERBS (DO NOT USE THESE UNDER ANY CIRCUMSTANCES):
   - WEAK VERBS: Built, Drove, Examined, Helped, Assisted, Used, Utilized, Employed, Worked, Handled, Managed, Did, Made, Created, Participated, Involved
   - OVERLY COMPLEX VERBS: Bolstered, Fortified, Orchestrated, Conceived, Instituted, Spearheaded, Fashioned, Aided, Hardened, Shaped, Piloted, Crafted, Enriched, Championed, Fostered
   - UNNECESSARILY GRANDIOSE VERBS: Accelerated, Revolutionized, Catalyzed, Disrupted, Transformed, Pioneered, Masterminded, Architected${verbAvoidanceText}${mostUsedVerbsText}
3) USE THESE SIMPLE, PROFESSIONAL VERBS INSTEAD:
   - Improved, Increased, Reduced, Decreased, Generated
   - Developed, Designed, Implemented, Established, Launched
   - Led, Directed, Coordinated, Supervised, Guided
   - Analyzed, Evaluated, Solved, Resolved, Fixed
4) Always choose straightforward, widely-used professional verbs that clearly communicate achievements

KEYWORD DISTRIBUTION REQUIREMENTS:
1) MANDATORY: Distribute keywords evenly across ALL bullets - never concentrate multiple keywords in one bullet. AIM for 1-2 relevant keywords per bullet maximum.
2) **Prioritize Relevance over Quantity:** It is MORE important that a keyword is placed *logically* within a bullet than it is to force every single keyword onto the resume. If a keyword cannot be naturally and logically integrated into *any* bullet without violating the consistency or meaning rules below, DO NOT USE IT.
3) Every keyword from ${keywords} SHOULD ideally be used at least once IF a logical place exists.
4) Keywords MUST flow within sentences as if originally written that way - integrate them smoothly.
5) NEVER list keywords together like "Used HTML, CSS, JavaScript to build..." – integrate them into the action or result description.

TECHNOLOGY LOGICAL CONSISTENCY REQUIREMENTS (ABSOLUTE PRIORITY - FOLLOW STEP-BY-STEP FOR EACH KEYWORD AND BULLET):
**BEFORE adding ANY keyword to ANY bullet, perform this explicit check:**
   **Step 1: Analyze the Bullet's Core.** Identify the specific *Action* taken (e.g., "Optimized database queries") and the specific *Result* achieved (e.g., "reduced latency by 30%"). Understand the original technical context (e.g., database interaction).
   **Step 2: Analyze the Keyword.** Consider the keyword's typical function (e.g., "React" is for building user interfaces; "SQL" is for database interaction; "JSON" is a data format).
   **Step 3: Test for Direct Causal Link.** Ask: Was this specific [Keyword] *directly used or instrumental* in performing the *Action* identified in Step 1? Did the use of this [Keyword] *directly contribute* to achieving the *Result* identified in Step 1?
      - *Example 1 (Logical):* Bullet Action/Result = "Optimized database queries, reducing latency". Keyword = "SQL". Test: Was SQL directly used to optimize queries and reduce latency? YES. --> **OK to potentially include.**
      - *Example 2 (Illogical):* Bullet Action/Result = "Optimized database queries, reducing latency". Keyword = "React". Test: Was React directly used to optimize *database* queries? NO. --> **DO NOT INCLUDE 'React' IN THIS BULLET.**
      - *Example 3 (Illogical):* Bullet Action/Result = "Increased user engagement by 30%". Keyword = "JSON". Test: Did using the data format JSON *directly cause* the increase in user engagement? NO (likely something else, like a feature built *using* data formatted as JSON, caused it). --> **DO NOT INCLUDE 'JSON' IN THIS BULLET as the cause.** Perhaps mention the feature itself if relevant.
   **Step 4: Verify Grouping Logic.** If considering adding multiple keywords to one bullet, ensure they were used *together interactively* for the *single specific Action/Result* described. Do NOT list unrelated tools used on the same project but for different tasks within one bullet.
   **Step 5: Natural Integration.** If Steps 1-4 pass, integrate the keyword smoothly into the sentence structure. It should sound like it belongs naturally in the description of the action or result. Avoid tacking keywords onto the end unnaturally.

MEANING PRESERVATION PRIORITY (CRITICAL - LINKED TO LOGICAL CONSISTENCY):
1) **The Original Meaning is Paramount.** The core message, scope, technologies originally mentioned (if any), and metrics of the input bullet point MUST be preserved.
2) **Keywords Enhance, Not Alter.** Integrating a keyword (following the Logical Consistency steps above) should only *add contextually relevant detail* if it fits logically. It must NEVER:
   - Change the primary action verb's meaning.
   - Contradict the original technical context (e.g., don't add a backend keyword to a bullet clearly describing frontend work unless it's logically linked per Step 3).
   - Change the scale or scope (e.g., team size, project impact).
   - Alter existing numerical metrics (%, $, time).
   - Make the original statement factually incorrect or nonsensical.
3) **If adding a keyword violates the original meaning or makes the bullet illogical (fails the Step 3 Causal Link Test), DO NOT ADD IT.** Refer back to Keyword Distribution Rule #2.

STAR METHOD REQUIREMENTS:
1) Structure each bullet to include elements of the STAR method:
   - Situation: Brief context
   - Task: Your responsibility
   - Action: Precise steps taken (incorporating keywords *only* if they pass the LOGICAL CONSISTENCY and MEANING PRESERVATION checks)
   - Result: Specific, quantifiable outcome
2) Example (Good): ">>Resolved database performance bottlenecks by optimizing SQL queries and implementing indexing strategy, cutting transaction processing time by 65%"
3) EVERY bullet MUST include at least one specific metric (%, $, time saved, etc.)
4) Preserve EXACT numbers from original bullets - never change metrics that already exist
5) Keep balanced focus on both actions and results

WORD LIMIT ADHERENCE:
1) Each bullet MUST stay within ${wordLimit} words
2) Never sacrifice metrics or core meaning to meet word limit

INPUT BULLETS TO ENHANCE (apply all rules carefully):
${(existingBullets || []).join('\n')}`;

    if (mode === 'tailor') {
        prompt = `${basePrompt}

INPUT BULLETS TO ENHANCE (integrate keywords naturally and logically across ALL bullets, following all rules meticulously):
${(existingBullets || []).join('\n')}`;
    } else {
        // Mode 'generate' - Less critical for this specific issue, but rules still apply
        prompt = `${basePrompt}

Generate 15 achievement-focused bullets ${context} with concrete metrics and varied action verbs.
REMEMBER: EVERY BULLET MUST START WITH >> (no space after) AND USE UNIQUE ACTION VERBS. Apply all Logical Consistency and Meaning Preservation rules.`;
    }

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${geminiApiKey}`,
            {
                system_instruction: {
                    parts: [{
                        text: "You are a specialized resume optimization AI. Your ONLY task is to generate resume bullet points. You MUST format all bullet points with '>>' prefix (no space after). Do not include ANY other text. Use a DIFFERENT action verb for each bullet point."
                    }]
                },
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.4, // Lower temperature for more predictable formatting
                    maxOutputTokens: 2000,
                    topP: 0.9,
                    topK: 40
                },
                safetySettings: [{
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_ONLY_HIGH"
                }]
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        const content = response.data.candidates[0].content.parts[0].text;
        
        // Primary matching for ">>" prefixed lines
        let matched = content.match(/^\>\>(.+)$/gm) || [];
        
        // Secondary matching for lines that might be bullet points but missing the prefix
        if (matched.length < 3) {
            console.log('Warning: Not enough ">>" prefixed bullets found, applying secondary extraction');
            
            // Extract any line that looks like a complete sentence and might be a bullet point
            const potentialBullets = content.split(/\n+/).filter(line => {
                // Filter for lines that start with an action verb (capitalized word)
                // and contain some text (at least 30 chars) and ideally have numbers
                const trimmed = line.trim();
                return trimmed.length > 30 && 
                       /^[A-Z][a-z]+/.test(trimmed) && 
                       (/\d+/.test(trimmed) || /ed\s/.test(trimmed));
            });
            
            // Add these as properly formatted bullets
            if (potentialBullets.length > 0) {
                const formattedBullets = potentialBullets.map(b => `>>${b}`);
                matched = [...matched, ...formattedBullets];
                console.log(`Added ${formattedBullets.length} secondary-extracted bullets`);
            }
        }
        
        // Clean up the bullets
        return matched.map(bp =>
            bp.replace(/^>>\s*/, '')
              .replace(/\*\*/g, '')
              .replace(/\s*\([^)]*\)$/, '') // Remove any trailing parenthesis and enclosed keywords
        );
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return []; // Return empty array in case of error
    }
}

// Add function to shuffle bullets with verb checking
function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 15; // Increased attempts to find better verb arrangements
    
    while (attempts < maxAttempts) {
        // Shuffle the array
        bullets = shuffleArray([...bullets]);
        
        // Check if the arrangement is valid
        let isValid = true;
        let previousVerbs = new Set();
        
        for (let i = 0; i < bullets.length; i++) {
            const currentVerb = getFirstVerb(bullets[i]);
            
            // Skip empty bullets
            if (!currentVerb) continue;
            
            // Check if verb is same as any previous bullet or already used as first verb globally
            if (previousVerbs.has(currentVerb) || 
                (verbTracker.isVerbUsedGlobally(currentVerb) && i === 0)) {
                isValid = false;
                break;
            }
            
            previousVerbs.add(currentVerb);
        }
        
        if (isValid) {
            // Add first verb to tracker
            if (bullets.length > 0) {
                verbTracker.addVerb(getFirstVerb(bullets[0]), sectionType);
            }
            return bullets;
        }
        
        attempts++;
    }
    
    // If we couldn't find a perfect arrangement, at least ensure the first verb is unique
    const sortedBullets = [...bullets].sort((a, b) => {
        const verbA = getFirstVerb(a);
        const verbB = getFirstVerb(b);
        
        // Put bullets with unused verbs at the beginning
        if (!verbTracker.isVerbUsedGlobally(verbA) && verbTracker.isVerbUsedGlobally(verbB)) {
            return -1;
        }
        if (verbTracker.isVerbUsedGlobally(verbA) && !verbTracker.isVerbUsedGlobally(verbB)) {
            return 1;
        }
        return 0;
    });
    
    // Add the first verb to the tracker
    if (sortedBullets.length > 0) {
        verbTracker.addVerb(getFirstVerb(sortedBullets[0]), sectionType);
    }
    
    return sortedBullets;
}

// Add BulletCache class for efficient bullet point management
class BulletCache {
    constructor() {
        this.cache = new Map();
        this.sectionPools = {
            job: new Set(),
            project: new Set(),
            education: new Set()
        };
        this.targetBulletCounts = {
            job: 7,
            project: 6,
            education: 5
        };
    }

    async generateAllBullets($, keywords, context, wordLimit, verbTracker) {
        const sections = ['job', 'project', 'education'];
        const cacheKey = `${keywords.join(',')}_${context}`;

        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        const allBullets = {};
        const promises = sections.map(async (section) => {
            const targetCount = this.targetBulletCounts[section];
            const bullets = await generateBullets(
                'generate',
                null,
                keywords,
                `for ${section} experience`,
                wordLimit,
                verbTracker
            );
            allBullets[section] = bullets.slice(0, targetCount);
            bullets.forEach(bullet => this.sectionPools[section].add(bullet));
        });

        await Promise.all(promises);
        this.cache.set(cacheKey, allBullets);
        return allBullets;
    }

    getBulletsForSection(section, count) {
        return Array.from(this.sectionPools[section]).slice(0, count);
    }

    addBulletToSection(bullet, section) {
        if (bullet && bullet.trim().length > 0) {
            this.sectionPools[section].add(bullet);
        }
    }

    clear() {
        this.cache.clear();
        Object.values(this.sectionPools).forEach(pool => pool.clear());
    }
}

// Update updateResumeSection to pass verbTracker to generateBullets
async function updateResumeSection($, sections, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache) {
    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        let bulletList = section.find('ul');

        if (bulletList.length === 0) {
            section.append('<ul></ul>');
            bulletList = section.find('ul');
        }

        let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount);
        
        if (fullTailoring && bulletList.find('li').length > 0) {
            const existingBullets = bulletList.find('li')
                .map((_, el) => $(el).text())
                .get();
                
            bulletPoints = await generateBullets(
                'tailor', existingBullets,
                keywords, context, wordLimit, verbTracker
            );
            
            // Add tailored bullets to cache
            bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
        }

        // Filter and shuffle bullets
        bulletPoints = bulletPoints
            .filter(bp => !bulletTracker.isUsed(bp) || 
                        bulletTracker.canUseBulletInSection(bp, sectionType))
            .slice(0, targetBulletCount);

        // Shuffle bullets with verb checking
        bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);

        // Update bullet list
        bulletList.empty();
        bulletPoints.forEach(point => {
            bulletTracker.addBullet(point, sectionType);
            // Also add the point's action verb to the verb tracker
            verbTracker.addVerb(getFirstVerb(point), sectionType);
            bulletList.append(`<li>${point}</li>`);
        });
    }
}

// Update adjustSectionBullets to use BulletCache
async function adjustSectionBullets($, selector, targetCount, sectionType, bulletTracker, keywords, context, bulletCache) {
    const sections = $(selector);
    sections.each((_, section) => {
        const bulletList = $(section).find('ul');
        const bullets = bulletList.find('li');
        const currentCount = bullets.length;

        if (currentCount > targetCount) {
            // Remove excess bullets from the end
            bullets.slice(targetCount).remove();
        } else if (currentCount < targetCount) {
            const cachedBullets = bulletCache.getBulletsForSection(sectionType, targetCount - currentCount);
            const validBullets = cachedBullets
                .filter(bp => !bulletTracker.isUsed(bp))
                .slice(0, targetCount - currentCount);

            validBullets.forEach(bullet => {
                bulletTracker.addBullet(bullet, sectionType);
                bulletList.append(`<li>${bullet}</li>`);
            });
        }
    });
}

async function ensureBulletRange(bulletPoints, usedBullets, generateFn, minCount, maxCount) {
    let attempts = 0;
    const originalBullets = [...bulletPoints];

    while (bulletPoints.length < minCount && attempts < 3) {
        const newPoints = (await generateFn()).filter(bp => !usedBullets.has(bp));
        bulletPoints = bulletPoints.concat(newPoints);
        attempts++;
    }

    // If still below minCount, use originals instead of placeholders
    while (bulletPoints.length < minCount) {
        const recycledBullet = originalBullets[bulletPoints.length % originalBullets.length];
        bulletPoints.push(recycledBullet || bulletPoints[0]); // Fallback to first bullet if needed
    }

    return bulletPoints.slice(0, maxCount);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function checkPageHeight(page) {
    return await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        return Math.max(
            body.scrollHeight,
            body.offsetHeight,
            html.clientHeight,
            html.scrollHeight,
            html.offsetHeight
        );
    });
}

async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    const customCSS = `
        @page {
            size: Letter;
            margin: 0.25in;
        }
        body {
            font-family: 'Calibri', 'Arial', sans-serif;
            font-size: 10pt;
            line-height: 1.15;
            margin: 0;
            padding: 0;
            color: #000;
            max-width: 100%;
        }
        
        /* Header Styling */
        h1 {
            text-align: center;
            margin: 0 0 2px 0;
            font-size: 22pt;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #000;
            font-weight: bold;
        }
        
        .contact-info {
            text-align: center;
            margin-bottom: 5px;
            width: 100%;
            display: flex;
            justify-content: center;
            gap: 3px;
            align-items: center;
            color: #000;
            font-size: 8.5pt;
        }
        
        /* Keep only the separator in gray */
        .contact-info > *:not(:last-child)::after {
            content: "|";
            margin-left: 3px;
            color: #333;
        }
        
        /* Section Styling */
        h2 {
            text-transform: uppercase;
            border-bottom: 1.25px solid #000;
            margin: 7px 0 3px 0;
            padding: 0;
            font-size: 12pt;
            font-weight: bold;
            letter-spacing: 0.5px;
            color: #000;
        }
        
        /* Experience Section */
        .job-details, .project-details, .education-details {
            margin-bottom: 4px;
        }
        
        .position-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 1px;
            flex-wrap: nowrap;
            width: 100%;
        }
        
        .position-left {
            display: flex;
            gap: 3px;
            align-items: baseline;
            flex: 1;
        }
        
        .company-name {
            font-weight: bold;
            font-style: italic;
            margin-right: 3px;
            font-size: 10.5pt;
        }
        
        .location {
            font-style: normal;
            margin-left: auto;
            padding-right: 3px;
        }
        
        /* Bullet Points */
        ul {
            margin: 0;
            padding-left: 15px;
            margin-bottom: 3px;
        }
        
        li {
            margin-bottom: 0;
            padding-left: 0;
            line-height: 1.2;
            text-align: justify;
            margin-top: 1px;
            font-size: 9.5pt;
        }
        
        /* Links */
        a {
            color: #000;
            text-decoration: none;
        }
        
        /* Date Styling */
        .date {
            font-style: italic;
            white-space: nowrap;
            min-width: fit-content;
            font-size: 9pt;
        }
        
        /* Skills Section */
        .skills-section {
            margin-bottom: 4px;
        }
        
        .skills-section p {
            margin: 1px 0;
            line-height: 1.2;
        }
        
        /* Adjust spacing between sections */
        section {
            margin-bottom: 5px;
        }
        
        /* Project Section */
        .project-title {
            font-weight: bold;
            font-style: italic;
            font-size: 10.5pt;
        }
        
        /* Education Section */
        .degree {
            font-style: italic;
            font-weight: bold;
            font-size: 10pt;
        }
        
        /* Position Title */
        .position-title {
            font-style: italic;
            font-weight: bold;
            font-size: 10.5pt;
        }
        
        /* Improved spacing for skills section */
        .skills-section p strong {
            font-weight: bold;
            font-size: 10pt;
        }
        
        /* Make section headings more prominent */
        .section-heading {
            font-size: 12pt;
            font-weight: bold;
            text-transform: uppercase;
            margin-bottom: 2px;
        }

        /* Skills items should be slightly larger than bullet points */
        .skills-section p {
            font-size: 9.5pt;
        }
    `;

    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);

    // Check page height
    const height = await checkPageHeight(page);
    const MAX_HEIGHT = 1056; // 11 inches * 96 DPI
    
    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
            top: '0.25in',
            right: '0.25in',
            bottom: '0.25in',
            left: '0.25in'
        }
    });

    await browser.close();
    return { pdfBuffer, exceedsOnePage: height > MAX_HEIGHT };
}

// Add new function to manage bullet points
async function adjustBulletPoints($, sections, currentBulletCount) {
    // Reduce bullets in all sections equally
    sections.forEach(section => {
        const bulletList = $(section).find('ul');
        const bullets = bulletList.find('li');
        if (bullets.length > currentBulletCount) {
            // Remove the last bullet
            bullets.last().remove();
        }
    });
    return currentBulletCount - 1;
}

// Add this new function after the lmCache declaration
async function categorizeKeywords(keywords) {
    if (!keywords || keywords.length === 0) return null;
    
    // Create cache key for this specific set of keywords
    const cacheKey = `categorize_v2_${keywords.sort().join(',')}`; // Added v2 to key for new prompt logic
    
    // Check cache first
    if (lmCache.has(cacheKey)) {
        return lmCache.get(cacheKey);
    }
    
    try {
        const prompt = `Analyze the provided keywords for relevance to Applicant Tracking Systems (ATS) focused on technical roles. Your goal is to select ONLY the most impactful technical skills, tools, platforms, and specific methodologies.

CRITERIA FOR INCLUSION (Prioritize these):
- Programming Languages (e.g., Python, Java, JavaScript, C++, SQL, HTML, CSS)
- Frameworks & Libraries (e.g., React, Node.js, Angular, TensorFlow, Scikit-learn, jQuery, Spring, Next.js, Pytorch)
- Databases & Caching (e.g., MySQL, Postgres, Redis)
- Cloud Platforms & Services (e.g., AWS, Kubeflow)
- Tools & Technologies (e.g., Git, Jira, Selenium)
- Specific Methodologies (e.g., Agile)
- Key Technical Concepts (e.g., REST APIs, Microservices, Computer Vision, Data Analytics, Machine Learning, OAuth, Encryption, Containerization)

CRITERIA FOR EXCLUSION (STRICTLY Exclude these types):
- Soft Skills (e.g., Problem-Solving, Leadership, Collaboration)
- General Business Concepts (e.g., Development Lifecycle, Performance Engineering, User Experience, Reusability, Consistency, Simplicity, Testing Practices, Project Management)
- Vague or Abstract Terms (e.g., Services, Modern Foundation, Data Sets, POCs, Coding Standards, Full Stack Engineering)
- Redundant terms if a more specific one exists (e.g., prefer 'REST APIs' over 'API' or 'APIs' if both contextually fit; prefer 'Agile Methodologies' over 'Agile' if present). Only include the most specific applicable term.

Based on these criteria, categorize the SELECTED keywords into the following specific categories:
- Languages: Programming and markup languages only.
- Frameworks/Libraries: Software frameworks and libraries only.
- Others: Relevant and specific APIs, cloud services, protocols, tools, methodologies, platforms, OS, databases, technical concepts from the inclusion list that don't fit elsewhere.
- Machine Learning Libraries: ML-specific libraries and frameworks ONLY (e.g., Tensorflow, Scikit-learn, Pytorch).

Keywords to analyze and select from: ${keywords.join(', ')}

Return ONLY a JSON object containing the SELECTED and CATEGORIZED keywords. Use these exact category names as keys: "Languages", "Frameworks/Libraries", "Others", "Machine Learning Libraries". The values should be arrays of the selected keywords. Every selected keyword MUST be placed in exactly one category. Do not include any keywords from the original list that fail the inclusion criteria or meet the exclusion criteria. Ensure the output is clean, valid JSON. Example format: {"Languages": ["Python", "SQL"], "Frameworks/Libraries": ["React"], "Others": ["AWS", "Git", "REST APIs"], "Machine Learning Libraries": ["Tensorflow"]}`;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${geminiApiKey}`,
            {
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 1000
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        const content = response.data.candidates[0].content.parts[0].text;
        
        // Extract JSON from response
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/{[\s\S]*?}/);
        const jsonString = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
        
        try {
            const categorized = JSON.parse(jsonString);
            lmCache.set(cacheKey, categorized);
            return categorized;
        } catch (jsonError) {
            console.error('Error parsing JSON from LLM response:', jsonError);
            // Fallback: attempt to create a simple structure based on the response
            const fallbackCategories = {
                "Languages": [],
                "Frameworks/Libraries": [],
                "Others": [],
                "Machine Learning Libraries": []
            };
            
            // Add all keywords to Others as fallback
            fallbackCategories["Others"] = keywords;
            lmCache.set(cacheKey, fallbackCategories);
            return fallbackCategories;
        }
    } catch (error) {
        console.error('Error categorizing keywords:', error.response?.data || error.message);
        return null;
    }
}

// Add this function to update the skills section in the resume
function updateSkillsSection($, keywords) {
    return new Promise(async (resolve, reject) => {
        try {
            const categorizedKeywords = await categorizeKeywords(keywords);
            if (!categorizedKeywords) {
                console.warn('Could not categorize keywords, skills section unchanged');
                resolve($);
                return;
            }
            
            // Find the skills section
            const skillsSection = $('.section-content').eq(0);
            if (skillsSection.length === 0) {
                console.warn('Skills section not found in resume');
                resolve($);
                return;
            }
            
            // Update each category
            const categoryMapping = {
                "Languages": "Languages:",
                "Frameworks/Libraries": "Frameworks/Libraries:",
                "Others": "Others (APIs, Services, Protocols):",
                "Machine Learning Libraries": "Machine Learning Libraries:"
            };
            
            Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                    const keywords = categorizedKeywords[dataKey].join(', ');
                    const paragraph = skillsSection.find(`p:contains("${htmlLabel}")`);
                    
                    if (paragraph.length > 0) {
                        // Update existing paragraph
                        paragraph.html(`<strong>${htmlLabel}</strong> ${keywords}`);
                    } else {
                        // Create new paragraph if category doesn't exist
                        skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywords}</p>`);
                    }
                }
            });
            
            resolve($);
        } catch (error) {
            console.error('Error updating skills section:', error);
            resolve($); // Resolve anyway to not block resume generation
        }
    });
}

// Update the updateResume function to include skill section modification
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const sectionWordCounts = getSectionWordCounts($);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Extract original bullets before any modifications
    const originalBullets = extractOriginalBullets($);
    
    // Update the skills section with keywords
    await updateSkillsSection($, keywords);
    
    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;
    
    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate all bullets upfront
    const allBullets = await bulletCache.generateAllBullets($, keywords, 'resume section', 15, verbTracker);

    const sections = [
        { selector: $('.job-details'), type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { selector: $('.project-details'), type: 'project', context: 'for a project', bullets: originalBullets.project },
        { selector: $('.education-details'), type: 'education', context: 'for education', bullets: originalBullets.education }
    ];

    // Update each section with its specific context
    for (const section of sections) {
        await updateResumeSection(
            $, section.selector, keywordString, section.context,
            fullTailoring, sectionWordCounts[section.type],
            bulletTracker, section.type, section.bullets,
            INITIAL_BULLET_COUNT, verbTracker, bulletCache
        );
    }

    // Check and adjust page length with smarter space management
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;

        // Reduce bullets proportionally based on section importance
        currentBulletCount--;
        for (const section of sections) {
            const adjustedCount = Math.max(
                MIN_BULLETS,
                Math.floor(currentBulletCount * (section.type === 'job' ? 1 : 0.8))
            );
            await adjustSectionBullets(
                $, section.selector, adjustedCount,
                section.type, bulletTracker, keywordString,
                section.context, bulletCache
            );
        }
        attempts++;
    }

    return $.html();
}

async function customizeResume(req, res) {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;

        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }

        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);

        // Validate HTML content
        if (htmlContent.length < 100) {
            console.error('HTML content too short, possibly invalid');
            return res.status(400).send('Invalid HTML content: Content too short');
        }

        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        console.log('Resume HTML updated successfully');
        
        // Validate the updated HTML to ensure it has bullet points
        const $ = cheerio.load(updatedHtmlContent);
        const jobBullets = $('.job-details li').length;
        const projectBullets = $('.project-details li').length;
        const educationBullets = $('.education-details li').length;
        
        console.log(`Generated bullet counts: Jobs=${jobBullets}, Projects=${projectBullets}, Education=${educationBullets}`);
        console.log('Skills section updated with relevant keywords');
        
        // Convert to PDF
        console.log('Converting updated HTML to PDF');
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }

        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=customized_resume.pdf');
        res.send(Buffer.from(pdfBuffer));
        
        console.log('Resume PDF sent to client successfully');

    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };
