const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for OpenAI
const openaiApiKey = process.env.OPENAI_API_KEY;
const lmCache = new Map();

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

function getSectionWordCounts($, selectors) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Helper function to count words in sections
    const countWordsInSections = (sectionSelectors, type) => {
        sectionSelectors.forEach(selector => {
            $(selector).each((_, section) => {
                selectors.bulletPoints.forEach(bulletSelector => {
                    $(section).find(bulletSelector).each((_, el) => {
                        const wordCount = countWordsInBullet($(el).text());
                        counts[type].total += wordCount;
                        counts[type].bullets++;
                    });
                });
            });
        });
    };

    // Count words in each section type
    countWordsInSections(selectors.jobSections, 'job');
    countWordsInSections(selectors.projectSections, 'project');
    countWordsInSections(selectors.educationSections, 'education');

    // Calculate average word count per bullet for each section
    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}

// Add new function to analyze HTML structure using GPT
async function analyzeHTMLStructure(htmlContent) {
    try {
        const prompt = `Analyze this HTML resume structure and identify the selectors (CSS classes, IDs, or tags) for key sections. Return a JSON object with these mappings.

HTML to analyze:
${htmlContent}

Focus on identifying these elements:
1. Job/work experience sections and their bullet points
2. Project sections and their bullet points
3. Education sections and their bullet points
4. Skills/technical skills section
5. Section headers/titles

Return ONLY a JSON object with these exact keys:
{
    "jobSections": ["array of selectors for job sections"],
    "projectSections": ["array of selectors for project sections"],
    "educationSections": ["array of selectors for education sections"],
    "skillsSection": ["array of selectors for skills section"],
    "bulletPoints": ["array of selectors for bullet points within any section"],
    "sectionHeaders": ["array of selectors for section headers/titles"]
}

Include ALL possible selectors that could match each section (classes, IDs, tags). Order from most specific to least specific.`;

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized HTML analyzer that identifies structural patterns in resume templates."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.3,
                max_tokens: 2000
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );

        const content = response.data.choices[0].message.content;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        return JSON.parse(jsonMatch[0]);
    } catch (error) {
        console.error('Error analyzing HTML structure:', error);
        // Return default selectors as fallback
        return {
            jobSections: ['.job-details', '.experience-section', '.work-experience'],
            projectSections: ['.project-details', '.projects-section', '.project-experience'],
            educationSections: ['.education-details', '.education-section'],
            skillsSection: ['.skills-section', '.technical-skills', '.skills'],
            bulletPoints: ['li', '.bullet-point'],
            sectionHeaders: ['.section-header', '.section-title', 'h2']
        };
    }
}

// Modify extractOriginalBullets to use dynamic selectors
async function extractOriginalBullets($, selectors) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: []
    };

    // Helper function to extract bullets from sections
    const extractBulletsFromSections = (sectionSelectors, bulletType) => {
        sectionSelectors.forEach(selector => {
            $(selector).each((_, section) => {
                // Find bullet points using all possible bullet selectors
                selectors.bulletPoints.forEach(bulletSelector => {
                    $(section).find(bulletSelector).each((_, bullet) => {
                        const bulletText = $(bullet).text().trim();
                        if (bulletText && !originalBullets[bulletType].includes(bulletText)) {
                            originalBullets[bulletType].push(bulletText);
                        }
                    });
                });
            });
        });
    };

    // Extract bullets from each section type
    extractBulletsFromSections(selectors.jobSections, 'job');
    extractBulletsFromSections(selectors.projectSections, 'project');
    extractBulletsFromSections(selectors.educationSections, 'education');

    // Handle any unassigned bullet points
    selectors.bulletPoints.forEach(bulletSelector => {
        $(bulletSelector).each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !Object.values(originalBullets).flat().includes(bulletText)) {
                originalBullets.unassigned.push(bulletText);
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

async function updateResumeSection($, sections, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache, selectors) {
    // Get the appropriate section selectors based on type
    const sectionSelectors = {
        job: selectors.jobSections,
        project: selectors.projectSections,
        education: selectors.educationSections
    }[sectionType] || [];

    // Find all matching sections using the selectors
    const matchingSections = [];
    sectionSelectors.forEach(selector => {
        const found = $(selector);
        if (found.length > 0) {
            found.each((_, el) => matchingSections.push($(el)));
        }
    });

    for (let i = 0; i < matchingSections.length; i++) {
        const section = matchingSections[i];
        
        // Find or create bullet list container
        let bulletContainer = null;
        selectors.bulletPoints.forEach(selector => {
            const container = section.find(selector).parent();
            if (container.length > 0 && !bulletContainer) {
                bulletContainer = container;
            }
        });

        if (!bulletContainer) {
            // Create new container based on existing format
            if (section.find('ul').length > 0) {
                bulletContainer = $('<ul>');
            } else if (section.find('ol').length > 0) {
                bulletContainer = $('<ol>');
            } else {
                bulletContainer = $('<ul>'); // Default to unordered list
            }
            section.append(bulletContainer);
        }

        let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount);
        
        if (fullTailoring) {
            // Get existing bullets using dynamic selectors
            const existingBullets = [];
            selectors.bulletPoints.forEach(selector => {
                section.find(selector).each((_, el) => {
                    const text = $(el).text().trim();
                    if (text && !existingBullets.includes(text)) {
                        existingBullets.push(text);
                    }
                });
            });

            if (existingBullets.length > 0) {
                bulletPoints = await generateBullets(
                    'tailor', existingBullets,
                    keywords, context, wordLimit, verbTracker
                );
                
                bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
            }
        }

        bulletPoints = bulletPoints
            .filter(bp => !bulletTracker.isUsed(bp) || 
                       bulletTracker.canUseBulletInSection(bp, sectionType))
            .slice(0, targetBulletCount);

        bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);

        // Clear existing bullets while preserving container
        bulletContainer.empty();

        // Add new bullets while maintaining original format
        const bulletTag = bulletContainer.is('ol, ul') ? 'li' : 'div';
        const bulletClass = section.find('.bullet, .bullet-point').attr('class') || '';

        bulletPoints.forEach(point => {
            bulletTracker.addBullet(point, sectionType);
            verbTracker.addVerb(getFirstVerb(point), sectionType);
            
            const bulletElement = $(`<${bulletTag}>`).text(point);
            if (bulletClass) {
                bulletElement.addClass(bulletClass);
            }
            bulletContainer.append(bulletElement);
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

// Update updateSkillsSection to use dynamic selectors
function updateSkillsSection($, keywords, selectors) {
    return new Promise(async (resolve, reject) => {
        try {
            const categorizedKeywords = await categorizeKeywords(keywords);
            if (!categorizedKeywords) {
                console.warn('Could not categorize keywords, skills section unchanged');
                resolve($);
                return;
            }

            // Find the skills section using provided selectors
            let skillsSection = null;
            for (const selector of selectors.skillsSection) {
                skillsSection = $(selector);
                if (skillsSection.length > 0) break;
            }

            if (!skillsSection || skillsSection.length === 0) {
                console.warn('Skills section not found in resume');
                resolve($);
                return;
            }

            // Analyze existing skills section structure
            const existingStructure = {
                hasParagraphs: skillsSection.find('p').length > 0,
                hasList: skillsSection.find('ul, ol').length > 0,
                hasTable: skillsSection.find('table').length > 0,
                hasStrong: skillsSection.find('strong').length > 0,
                originalFormat: ''
            };

            // Determine the original format
            if (existingStructure.hasParagraphs) {
                existingStructure.originalFormat = 'paragraph';
            } else if (existingStructure.hasList) {
                existingStructure.originalFormat = 'list';
            } else if (existingStructure.hasTable) {
                existingStructure.originalFormat = 'table';
            }

            const categoryMapping = {
                "Languages": "Languages:",
                "Frameworks/Libraries": "Frameworks/Libraries:",
                "Others": "Others (APIs, Services, Protocols):",
                "Machine Learning Libraries": "Machine Learning Libraries:"
            };

            // Clear existing content while preserving structure
            skillsSection.children().not(selectors.sectionHeaders.join(', ')).remove();

            // Update content based on original format
            Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                    const keywords = categorizedKeywords[dataKey].join(', ');
                    
                    switch (existingStructure.originalFormat) {
                        case 'paragraph':
                            const p = $('<p>');
                            if (existingStructure.hasStrong) {
                                p.append($('<strong>').text(htmlLabel));
                                p.append(` ${keywords}`);
                            } else {
                                p.text(`${htmlLabel} ${keywords}`);
                            }
                            skillsSection.append(p);
                            break;

                        case 'list':
                            const li = $('<li>');
                            if (existingStructure.hasStrong) {
                                li.append($('<strong>').text(htmlLabel));
                                li.append(` ${keywords}`);
                            } else {
                                li.text(`${htmlLabel} ${keywords}`);
                            }
                            
                            let ul = skillsSection.find('ul');
                            if (ul.length === 0) {
                                ul = $('<ul>');
                                skillsSection.append(ul);
                            }
                            ul.append(li);
                            break;

                        case 'table':
                            const tr = $('<tr>');
                            tr.append($('<td>').text(htmlLabel));
                            tr.append($('<td>').text(keywords));
                            
                            let table = skillsSection.find('table');
                            if (table.length === 0) {
                                table = $('<table>');
                                skillsSection.append(table);
                            }
                            table.append(tr);
                            break;

                        default:
                            // Default to paragraph format
                            skillsSection.append($('<p>').html(`<strong>${htmlLabel}</strong> ${keywords}`));
                    }
                }
            });

            resolve($);
        } catch (error) {
            console.error('Error updating skills section:', error);
            resolve($);
        }
    });
}

// Update the updateResume function to include skill section modification
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const sectionWordCounts = getSectionWordCounts($, selectors);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Extract original bullets before any modifications
    const selectors = await analyzeHTMLStructure(htmlContent);
    const originalBullets = await extractOriginalBullets($, selectors);
    
    // Update the skills section with keywords
    await updateSkillsSection($, keywords, selectors);
    
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
            INITIAL_BULLET_COUNT, verbTracker, bulletCache, selectors
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