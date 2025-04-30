const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for OpenAI
const openaiApiKey = process.env.OPENAI_API_KEY;
const lmCache = new Map();

// Constants for section identification
const SECTION_KEYWORDS = {
    job: ['experience', 'employment', 'work history', 'professional experience'],
    project: ['projects', 'personal projects', 'portfolio'],
    education: ['education', 'academic background', 'qualifications'],
    skills: ['skills', 'technical skills', 'proficiencies', 'expertise', 'technologies']
};

const HEADER_SELECTORS = 'h1, h2, h3, h4, h5, h6, p > strong, p > b, div > strong, div > b';

/**
 * Identifies major resume sections based on keywords in header-like elements.
 * @param {cheerio.Root} $ - Cheerio root object.
 * @returns {Map<string, cheerio.Cheerio>} Map of section type ('job', 'project', etc.) to the Cheerio element containing that section's content.
 */
function identifySections($) {
    const sections = new Map();
    const potentialHeaders = $(HEADER_SELECTORS);
    let lastHeaderElement = null;
    let lastHeaderType = null;

    potentialHeaders.each((_, header) => {
        const headerText = $(header).text().trim().toLowerCase();
        if (!headerText) return;

        let foundType = null;
        for (const [type, keywords] of Object.entries(SECTION_KEYWORDS)) {
            if (keywords.some(kw => headerText.includes(kw))) {
                foundType = type;
                break;
            }
        }

        if (foundType) {
            if (lastHeaderElement && lastHeaderType) {
                const startElement = lastHeaderElement.first().parent();
                const endElement = $(header).first().parent();
                sections.set(lastHeaderType, lastHeaderElement);
            }
            lastHeaderElement = $(header);
            lastHeaderType = foundType;
        }
    });

    if (lastHeaderElement && lastHeaderType) {
        sections.set(lastHeaderType, lastHeaderElement);
    }

    const refinedSections = new Map();
    sections.forEach((headerElement, type) => {
        let currentElement = headerElement.parent();
        let sectionContainer = currentElement;

        let nextSectionHeaderParent = null;
        sections.forEach((nextHeader, nextType) => {
            if (nextType !== type && nextHeader.parent().length > 0) {
                if (headerElement.closest(nextHeader.parent().parent()).length === 0 && 
                    headerElement.nextAll(nextHeader.parent()).length > 0) {
                    if (!nextSectionHeaderParent || nextHeader.parent().index() < nextSectionHeaderParent.index()) {
                        nextSectionHeaderParent = nextHeader.parent();
                    }
                }
            }
        });

        if (currentElement.find('ul, ol, p, div').length > 1) {
            sectionContainer = currentElement;
        } else {
            sectionContainer = currentElement.parent();
        }

        refinedSections.set(type, sectionContainer);
        console.log(`Identified section [${type}] in container: ${sectionContainer.prop('tagName')}.${sectionContainer.attr('class') || ''}`);
    });

    if (refinedSections.size === 0) {
        console.warn("Primary section identification failed, trying fallback based on lists near headers.");
        potentialHeaders.each((_, header) => {
            const headerText = $(header).text().trim().toLowerCase();
            let foundType = null;
            for (const [type, keywords] of Object.entries(SECTION_KEYWORDS)) {
                if (keywords.some(kw => headerText.includes(kw))) {
                    foundType = type;
                    break;
                }
            }

            if (foundType && !refinedSections.has(foundType)) {
                const list = $(header).parent().find('+ ul, + ol').first();
                if (list.length > 0) {
                    console.log(`Fallback identified section [${type}] linked to list: ${list.prop('tagName')}`);
                    refinedSections.set(type, list.parent());
                } else {
                    const parentList = $(header).parent().find('ul, ol').first();
                    if (parentList.length > 0) {
                        console.log(`Fallback identified section [${type}] linked to list within parent: ${parentList.prop('tagName')}`);
                        refinedSections.set(type, $(header).parent());
                    }
                }
            }
        });
    }

    if (refinedSections.size === 0) {
        console.error("CRITICAL: Could not identify any resume sections. Processing may fail.");
    } else {
        console.log("Identified sections:", Array.from(refinedSections.keys()));
    }

    return refinedSections;
}

/**
 * Finds bullet point elements (primarily <li>) within a given section container.
 * @param {cheerio.Cheerio} $sectionContainer - Cheerio element for the section.
 * @returns {cheerio.Cheerio} Cheerio object containing all identified bullet point elements (<li>).
 */
function findBulletPoints($sectionContainer) {
    if (!$sectionContainer || $sectionContainer.length === 0) return cheerio.load('')('<div></div>');

    let bullets = $sectionContainer.find('ul > li, ol > li');

    if (bullets.length === 0) {
        bullets = $sectionContainer.find('li');
    }

    return bullets;
}

/**
 * Finds keyword group elements within the skills section.
 * @param {cheerio.Root} $ - Cheerio root object.
 * @param {cheerio.Cheerio} $skillsContainer - Cheerio element for the skills section.
 * @returns {Map<string, {labelElement: cheerio.Cheerio | null, keywordsElement: cheerio.Cheerio}>} Map of category name to elements.
 */
function findKeywordGroups($, $skillsContainer) {
    const groups = new Map();
    if (!$skillsContainer || $skillsContainer.length === 0) return groups;

    $skillsContainer.find('p, div').each((_, container) => {
        const labelElement = $(container).find('strong:first-child, b:first-child');
        const labelText = labelElement.text().trim().toLowerCase().replace(':', '');

        if (labelElement.length > 0 && labelText) {
            const keywordsElement = $(container);
            groups.set(labelText, { labelElement, keywordsElement });
        }
    });

    if (groups.size === 0) {
        const lists = $skillsContainer.find('ul, ol');
        if (lists.length > 0) {
            groups.set('default_list', { labelElement: null, keywordsElement: lists });
        } else {
            const directContent = $skillsContainer.children('p, div').length > 0
                ? $skillsContainer.children('p, div')
                : $skillsContainer;
            groups.set('default', { labelElement: null, keywordsElement: directContent });
        }
    }

    return groups;
}

function countWordsInBullet(text) {
    const cleaned = text.trim()
        .replace(/[""]/g, '') // Remove smart quotes
        .replace(/[.,!?()]/g, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize spaces
    
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

    $('.job-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });

    $('.project-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });

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

    $('.job-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.job.includes(bulletText)) {
                originalBullets.job.push(bulletText);
            }
        });
    });

    $('.project-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.project.includes(bulletText)) {
                originalBullets.project.push(bulletText);
            }
        });
    });

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
        if (!this.bulletMap.has(bulletText)) return true;
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
        
        if (!verb || !verb.match(/^[a-z]+$/)) return;
        
        if (!this.usedVerbs.has(sectionType)) {
            this.usedVerbs.set(sectionType, new Set());
        }
        this.usedVerbs.get(sectionType).add(verb);
        this.globalVerbs.add(verb);
        
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
async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    const basePrompt = `You are a specialized resume bullet point optimizer. Engage in chain-of-thought reasoning: before generating or enhancing resume bullets, think out loud—reflect step by step on the user's input, context, and keywords, justifying each keyword and technology choice to ensure coherent, ATS-friendly, and relevant results. Avoid illogical pairings (e.g., Apex with Java). After your chain-of-thought, generate or enhance resume bullets following these strict rules:

FORMATTING RULES:
1. Every bullet MUST start with '>>' (no space after)
2. One specific metric per bullet (%, $, time, or quantity)
3. Each bullet MUST begin with a strong action verb
4. NEVER reuse the same starting verb across bullet points
5. Each bullet MUST be ${wordLimit} words or less

KEYWORD INTEGRATION RULES:
1. Use keywords from this list: ${keywords}
2. Use ONLY 1-2 related technologies per bullet
3. NEVER combine unrelated technologies in the same bullet point
4. Each keyword MUST be used at least once across all bullets
5. If a technology doesn't fit naturally, preserve the achievement and remove ALL tech references

TECHNOLOGY COMBINATION RULES:
1. Keep technologies within their domain (frontend, backend, etc.)
2. Frontend tools stay with frontend (e.g., React with CSS)
3. Backend tools stay with backend (e.g., Node.js with MongoDB)
4. Database operations stay with database tools
5. NEVER mix frontend tools with backend/database operations

EXAMPLES OF PROPER TECHNOLOGY INTEGRATION:

GOOD (Related Technologies):
>>Developed React components with CSS animations, reducing page load time by 40%
>>Implemented Python data processing pipeline using PostgreSQL, handling 1M daily records
>>Optimized Node.js API endpoints with Redis caching, supporting 50K daily users

BAD (Unrelated Technologies):
>>Used React to optimize PostgreSQL queries (Frontend tool for database tasks)
>>Implemented Python in React components (Mixing unrelated languages)
>>Built MongoDB interface using CSS Grid (Database tasks with styling tools)

ACTION VERB GUIDELINES:
Approved Verbs:
- Performance: Improved, Increased, Reduced, Decreased, Optimized
- Development: Developed, Designed, Implemented, Created, Launched
- Leadership: Led, Directed, Coordinated, Managed
- Analysis: Analyzed, Evaluated, Solved

Prohibited Verbs:
- Weak: Built, Helped, Used, Worked
- Complex: Orchestrated, Spearheaded, Piloted
- Grandiose: Revolutionized, Transformed, Pioneered

METRICS GUIDELINES:
1. Keep all existing numbers EXACTLY as provided
2. Each bullet MUST include ONE specific metric:
   - Percentages (e.g., "reduced costs by 40%")
   - Time (e.g., "decreased load time by 2.5 seconds")
   - Quantity (e.g., "supported 100K users")
   - Money (e.g., "saved $50K annually")

INPUT TO ENHANCE:
${(existingBullets || []).join('\n')}`;

    const prompt = mode === 'tailor' 
        ? `${basePrompt}\n\nTASK: Enhance the above bullets by naturally integrating the provided keywords. Maintain original metrics and achievements.`
        : `${basePrompt}\n\nTASK: Generate 15 achievement-focused bullets ${context} with concrete metrics and varied action verbs.`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume bullet point optimizer. First, think out loud: analyze the user's input, context, and keyword list step by step, reflecting on which keywords and technologies should be included or omitted, and justify each decision to ensure logical, ATS-friendly, and relevant results. Avoid illogical pairings (e.g., Apex with Java). After your chain-of-thought, generate or enhance resume bullets following these STRICT rules:\n1. Every bullet MUST start with '>>' (no space)\n2. Use ONLY related technologies together\n3. Use each provided keyword at least once\n4. Include ONE specific metric per bullet\n5. Use ONLY approved action verbs\n6. Never exceed word limit\n7. Never mix unrelated technologies\n8. Focus on concrete achievements"
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.5,
                max_tokens: 4096,
                top_p: 1
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );

        const content = response.data.choices[0].message.content;
        
        // Extract bullets that start with ">>"
        let bullets = content.match(/^\>\>(.+)$/gm) || [];
        
        // If we don't have enough bullets, try to extract complete sentences
        if (bullets.length < 3) {
            const additionalBullets = content.split(/\n+/)
                .filter(line => {
                    const trimmed = line.trim();
                    return trimmed.length > 30 && 
                           /^[A-Z]/.test(trimmed) && 
                           /\d+/.test(trimmed);
                })
                .map(b => `>>${b}`);
            
            bullets = [...bullets, ...additionalBullets];
        }
        
        // Clean and format bullets
        return bullets.map(bullet => 
            bullet.replace(/^>>\s*/, '')
                  .replace(/\*\*/g, '')
                  .replace(/\s*\([^)]*\)$/, '')
        );
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}

// Add function to shuffle bullets with verb checking
function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 15;
    
    while (attempts < maxAttempts) {
        bullets = shuffleArray([...bullets]);
        
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
    
    const sortedBullets = [...bullets].sort((a, b) => {
        const verbA = getFirstVerb(a);
        const verbB = getFirstVerb(b);
        
        if (!verbTracker.isVerbUsedGlobally(verbA) && verbTracker.isVerbUsedGlobally(verbB)) {
            return -1;
        }
        if (verbTracker.isVerbUsedGlobally(verbA) && !verbTracker.isVerbUsedGlobally(verbB)) {
            return 1;
        }
        return 0;
    });
    
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

async function updateResumeSection($, sectionContainer, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, targetBulletCount, verbTracker, bulletCache) {
    if (!sectionContainer || sectionContainer.length === 0) {
        console.warn(`Skipping update for section type '${sectionType}': Container not found.`);
        return;
    }

    console.log(`Updating section type '${sectionType}'...`);
    const bulletPointsElements = findBulletPoints(sectionContainer);
    const originalBulletTexts = bulletPointsElements.map((_, el) => $(el).text().trim()).get();

    let generatedBullets = [];

    if (fullTailoring && originalBulletTexts.length > 0) {
        console.log(`Tailoring ${originalBulletTexts.length} existing bullets for section '${sectionType}'`);
        generatedBullets = await generateBullets(
            'tailor',
            originalBulletTexts,
            keywords,
            context,
            wordLimit
        );
        generatedBullets.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
    } else {
        console.log(`Generating new bullets for section '${sectionType}'`);
        if (bulletCache.getBulletsForSection(sectionType, 1).length === 0) {
            const bullets = await generateBullets('generate', null, keywords, context, wordLimit);
            bullets.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
        }
        generatedBullets = bulletCache.getBulletsForSection(sectionType, targetBulletCount * 2);
    }

    let finalBullets = generatedBullets
        .filter(bp => bp && bp.length > 10)
        .filter(bp => !bulletTracker.isUsed(bp) || bulletTracker.canUseBulletInSection(bp, sectionType));

    finalBullets = shuffleBulletsWithVerbCheck(finalBullets, sectionType, verbTracker);
    finalBullets = finalBullets.slice(0, targetBulletCount);

    console.log(`Applying ${finalBullets.length} bullets to section '${sectionType}'`);

    const listContainer = bulletPointsElements.parent('ul, ol').first();

    if (listContainer.length > 0) {
        const existingLiCount = bulletPointsElements.length;

        for (let i = 0; i < finalBullets.length; i++) {
            const bulletText = finalBullets[i];
            bulletTracker.addBullet(bulletText, sectionType);
            verbTracker.addVerb(getFirstVerb(bulletText), sectionType);

            if (i < existingLiCount) {
                bulletPointsElements.eq(i).html(bulletText);
            } else {
                listContainer.append($('<li>').html(bulletText));
            }
        }

        if (finalBullets.length < existingLiCount) {
            bulletPointsElements.slice(finalBullets.length).remove();
        }
        console.log(`Updated list in section '${sectionType}'`);

    } else if (finalBullets.length > 0) {
        console.warn(`No UL/OL found in section '${sectionType}'. Creating a new UL.`);
        const newList = $('<ul></ul>');
        finalBullets.forEach(point => {
            bulletTracker.addBullet(point, sectionType);
            verbTracker.addVerb(getFirstVerb(point), sectionType);
            newList.append($('<li>').html(point));
        });

        const header = sectionContainer.find(HEADER_SELECTORS).filter((_, el) => 
            SECTION_KEYWORDS[sectionType].some(kw => $(el).text().toLowerCase().includes(kw))
        ).first();
        
        if (header.length > 0) {
            header.parent().append(newList);
        } else {
            sectionContainer.append(newList);
        }
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

    while (bulletPoints.length < minCount) {
        const recycledBullet = originalBullets[bulletPoints.length % originalBullets.length];
        bulletPoints.push(recycledBullet || bulletPoints[0]);
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

    // Set content without injecting new styles
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    // Check page height using rendered dimensions
    const height = await page.evaluate(() => {
        return document.documentElement.scrollHeight;
    });

    // Standard Letter height in pixels at 96 DPI (approx)
    // 11 inches * 96 DPI = 1056px. Add a small buffer.
    const MAX_HEIGHT_PX = 1056 * 1.05; // Allow 5% overflow margin

    console.log(`Rendered page height: ${height}px (Max target: ~${MAX_HEIGHT_PX}px)`);

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
    return { pdfBuffer, exceedsOnePage: height > MAX_HEIGHT_PX };
}

// Add new function to manage bullet points
async function adjustBulletPoints($, sections, currentBulletCount) {
    sections.forEach(section => {
        const bulletList = $(section).find('ul');
        const bullets = bulletList.find('li');
        if (bullets.length > currentBulletCount) {
            bullets.last().remove();
        }
    });
    return currentBulletCount - 1;
}

// Update categorizeKeywords function to use OpenAI API
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
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are an AI trained to categorize technical keywords for resumes."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.4,
                max_tokens: 2000,
                top_p: 1
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );

        const content = response.data.choices[0].message.content;
        
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
async function updateSkillsSection($, keywords) {
    try {
        const categorizedKeywords = await categorizeKeywords(keywords);
        if (!categorizedKeywords) {
            console.warn('Could not categorize keywords, skills section unchanged');
            return $;
        }

        const sections = identifySections($);
        const skillsContainer = sections.get('skills');
        if (!skillsContainer) {
            console.warn('Skills section not found in resume');
            return $;
        }

        const existingGroups = findKeywordGroups($, skillsContainer);
        console.log("Found existing skill groups:", Array.from(existingGroups.keys()));

        const categoryMapping = {
            "Languages": ["languages"],
            "Frameworks/Libraries": ["frameworks", "libraries", "frameworks/libraries"],
            "Others": ["others", "tools", "platforms", "databases", "cloud", "technologies"],
            "Machine Learning Libraries": ["machine learning", "ml", "ai"]
        };

        const updatedCategories = new Set();

        for (const [category, data] of Object.entries(categorizedKeywords)) {
            if (!data || data.length === 0) continue;

            const targetLabels = categoryMapping[category] || [category.toLowerCase()];
            let updated = false;

            for (const [existingLabel, { labelElement, keywordsElement }] of existingGroups) {
                if (targetLabels.some(tl => existingLabel.includes(tl))) {
                    console.log(`Updating existing skills group: '${existingLabel}' with new ${category} keywords.`);
                    
                    if (keywordsElement.is('ul, ol')) {
                        keywordsElement.empty();
                        data.forEach(kw => keywordsElement.append($('<li>').text(kw)));
                    } else {
                        const newKeywordsString = data.join(', ');
                        if (labelElement) {
                            keywordsElement.contents().filter(function() {
                                return this.nodeType === 3;
                            }).last().replaceWith(' ' + newKeywordsString);
                        } else {
                            keywordsElement.text(newKeywordsString);
                        }
                    }
                    updatedCategories.add(existingLabel);
                    updated = true;
                    break;
                }
            }

            if (!updated) {
                console.log(`Adding new skills group: '${category}'`);
                const newKeywordsString = data.join(', ');
                const sampleGroup = existingGroups.values().next().value;
                let newElement;
                
                if (sampleGroup && sampleGroup.keywordsElement.is('ul, ol')) {
                    newElement = $('<ul></ul>');
                    data.forEach(kw => newElement.append($('<li>').text(kw)));
                    const labelText = category + ":";
                    skillsContainer.append($('<p>').append($('<strong>').text(labelText)));
                    skillsContainer.append(newElement);
                } else if (sampleGroup && sampleGroup.keywordsElement.is('p, div')) {
                    const tagName = sampleGroup.keywordsElement.prop('tagName') || 'p';
                    const labelText = category + ":";
                    newElement = $(`<${tagName}>`).append($('<strong>').text(labelText)).append(' ' + newKeywordsString);
                    skillsContainer.append(newElement);
                } else {
                    const labelText = category + ":";
                    newElement = $('<p>').append($('<strong>').text(labelText)).append(' ' + newKeywordsString);
                    skillsContainer.append(newElement);
                }
            }
        }

        return $;
    } catch (error) {
        console.error('Error updating skills section:', error);
        return $;
    }
}

// Update the updateResume function to include skill section modification
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();

    // Identify sections using our new dynamic approach
    const identifiedSections = identifySections($);
    if (identifiedSections.size === 0) {
        throw new Error("Failed to identify critical resume sections (Experience, Skills, etc.). Cannot proceed.");
    }

    // Update the skills section with keywords
    await updateSkillsSection($, keywords);

    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;

    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate all bullets upfront
    await bulletCache.generateAllBullets($, keywords, 'resume section', 15, verbTracker);

    // Update each section with its specific context
    const sectionTypes = ['job', 'project', 'education'];
    for (const sectionType of sectionTypes) {
        const sectionContainer = identifiedSections.get(sectionType);
        if (sectionContainer) {
            await updateResumeSection(
                $, sectionContainer, keywordString,
                `for ${sectionType} experience`, fullTailoring,
                15, // Default word limit since we can't reliably get section word counts
                bulletTracker, sectionType, INITIAL_BULLET_COUNT,
                verbTracker, bulletCache
            );
        } else {
            console.warn(`Section type '${sectionType}' not found in resume.`);
        }
    }

    // Check and adjust page length
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;

        // Reduce bullets proportionally based on section importance
        currentBulletCount--;
        console.log(`Attempt ${attempts + 1}: Reducing bullet count to ${currentBulletCount}`);

        for (const sectionType of sectionTypes) {
            const sectionContainer = identifiedSections.get(sectionType);
            if (sectionContainer) {
                const adjustedCount = Math.max(
                    MIN_BULLETS,
                    Math.floor(currentBulletCount * (sectionType === 'job' ? 1 : 0.8))
                );

                const bullets = findBulletPoints(sectionContainer);
                if (bullets.length > adjustedCount) {
                    bullets.slice(adjustedCount).remove();
                    console.log(`Reduced ${sectionType} section to ${adjustedCount} bullets`);
                }
            }
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
            return res.status(400).send('Invalid HTML content: Content too short');
        }

        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        const $ = cheerio.load(updatedHtmlContent);
        const jobBullets = $('.job-details li').length;
        const projectBullets = $('.project-details li').length;
        const educationBullets = $('.education-details li').length;
        
        console.log(`Generated bullet counts: Jobs=${jobBullets}, Projects=${projectBullets}, Education=${educationBullets}`);
        
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }

        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };