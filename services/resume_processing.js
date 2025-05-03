const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util');

const openaiApiKey = process.env.OPENAI_API_KEY;
const lmCache = new Map();

function countWordsInBullet(text) {
    const cleaned = text.trim()
        .replace(/["\"]/g, '')
        .replace(/[.,!?()]/g, '')
        .replace(/\s+/g, ' ');
    const words = cleaned.split(' ')
        .filter(word => word.length > 0)
        .map(word => word.replace(/-/g, ''));
    return words.length;
}

function getSectionWordCounts($, selectors) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 }
    };
    $(selectors.jobBulletSelector).each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });
    $(selectors.projectBulletSelector).each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });
    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15
    };
}

function extractOriginalBullets($, selectors) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: []
    };
    $(selectors.jobSectionSelector).each((_, section) => {
        $(section).find(selectors.jobBulletSelector.replace(selectors.jobSectionSelector, '').trim()).each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.job.includes(bulletText)) {
                originalBullets.job.push(bulletText);
            }
        });
    });
    $(selectors.projectSectionSelector).each((_, section) => {
        $(section).find(selectors.projectBulletSelector.replace(selectors.projectSectionSelector, '').trim()).each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.project.includes(bulletText)) {
                originalBullets.project.push(bulletText);
            }
        });
    });
    $(selectors.educationSectionSelector).each((_, section) => {
        $(section).find(selectors.educationBulletSelector.replace(selectors.educationSectionSelector, '').trim()).each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.education.includes(bulletText)) {
                originalBullets.education.push(bulletText);
            }
        });
    });
    $('li').each((_, bullet) => {
        const bulletText = $(bullet).text().trim();
        const isAssigned = originalBullets.job.includes(bulletText) ||
                           originalBullets.project.includes(bulletText) ||
                           originalBullets.education.includes(bulletText);
        if (bulletText && !isAssigned && !originalBullets.unassigned.includes(bulletText)) {
             if (!$(bullet).closest(selectors.jobSectionSelector).length &&
                 !$(bullet).closest(selectors.projectSectionSelector).length &&
                 !$(bullet).closest(selectors.educationSectionSelector).length) {
                originalBullets.unassigned.push(bulletText);
             }
        }
    });
    return originalBullets;
}

class SectionBulletTracker {
    constructor() {
        this.bulletMap = new Map();
        this.usedBullets = new Set();
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

class ActionVerbTracker {
    constructor() {
        this.usedVerbs = new Map();
        this.globalVerbs = new Set();
        this.verbSynonyms = new Map();
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

function getFirstVerb(bulletText) {
    return bulletText.trim().split(/\s+/)[0].toLowerCase();
}

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
5. ALL provided keywords MUST be integrated across the set of bullets—do not omit any keyword
6. If a technology doesn't fit naturally, preserve the achievement and remove ALL tech references

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
        ? `${basePrompt}\n\nTASK: Enhance the above bullets by naturally and thoroughly integrating ALL provided keywords. Every keyword must appear at least once across the set. Maintain original metrics and achievements.`
        : `${basePrompt}\n\nTASK: Generate 15 achievement-focused bullets ${context} with concrete metrics and varied action verbs, ensuring that ALL provided keywords are integrated at least once across the set.`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume bullet point optimizer. First, think out loud: analyze the user's input, context, and keyword list step by step, reflecting on which keywords and technologies should be included or omitted, and justify each decision to ensure logical, ATS-friendly, and relevant results. Avoid illogical pairings (e.g., Apex with Java). After your chain-of-thought, generate or enhance resume bullets following these STRICT rules:\n1. Every bullet MUST start with '>>' (no space)\n2. Use ONLY related technologies together\n3. Use each provided keyword at least once, and ensure ALL keywords are integrated across the set\n4. Include ONE specific metric per bullet\n5. Use ONLY approved action verbs\n6. Never exceed word limit\n7. Never mix unrelated technologies\n8. Focus on concrete achievements"
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
        const lines = content.split('\n');
        const seenBullets = new Set();
        const bullets = lines
            .map(line => line.trim())
            .filter(line => line.startsWith('>>'))
            .map(bullet => 
                bullet.replace(/^>>\s*/, '')
                      .replace(/\*\*/g, '')
                      .replace(/\s*\([^)]*\)$/, '')
            )
            .filter(bullet => {
                const norm = bullet.toLowerCase().replace(/\s+/g, ' ').trim();
                if (seenBullets.has(norm)) return false;
                seenBullets.add(norm);
                return true;
            });
        return bullets;
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}

function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 15;
    while (attempts < maxAttempts) {
        bullets = shuffleArray([...bullets]);
        let isValid = true;
        let previousVerbs = new Set();
        for (let i = 0; i < bullets.length; i++) {
            const currentVerb = getFirstVerb(bullets[i]);
            if (!currentVerb) continue;
            if (previousVerbs.has(currentVerb) || 
                (verbTracker.isVerbUsedGlobally(currentVerb) && i === 0)) {
                isValid = false;
                break;
            }
            previousVerbs.add(currentVerb);
        }
        if (isValid) {
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

class BulletCache {
    constructor() {
        this.cache = new Map();
        this.sectionPools = {
            job: new Set(),
            project: new Set()
        };
        this.targetBulletCounts = {
            job: 5,
            project: 4
        };
    }
    async generateAllBullets($, keywords, context, wordLimit, verbTracker) {
        const sections = ['job', 'project'];
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
        const seen = new Set();
        const uniqueBullets = [];
        for (const bullet of this.sectionPools[section]) {
            const norm = bullet.toLowerCase().replace(/\s+/g, ' ').trim();
            if (!seen.has(norm)) {
                seen.add(norm);
                uniqueBullets.push(bullet);
            }
            if (uniqueBullets.length >= count) break;
        }
        return uniqueBullets;
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

async function updateResumeSection($, sectionSelector, bulletSelector, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache) {
    if (sectionType === 'education') {
        console.log("Skipping bullet point generation for Education section");
        return;
    }
    const sections = $(sectionSelector);
    console.log(`Found ${sections.length} ${sectionType} sections using selector: ${sectionSelector}`);
    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        const educationTitle = section.find('div.section-title:contains("Education")');
        if (educationTitle.length > 0) {
            console.warn(`Skipping section that appears to be Education but matched ${sectionType} selector`);
            continue;
        }
        let bulletList = section.find('ul');
        if (bulletList.length === 0) {
            section.append('<ul></ul>');
            bulletList = section.find('ul');
            if (bulletList.length === 0) {
                 console.warn(`Could not find or create bullet list within section: ${sectionSelector}`);
                 continue;
            }
        }
        const bulletElementSelector = bulletSelector.replace(sectionSelector, '').trim().split(' ').pop() || 'li';
        let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount);
        if (fullTailoring && bulletList.find(bulletElementSelector).length > 0) {
            const existingBullets = bulletList.find(bulletElementSelector)
                .map((_, el) => $(el).text())
                .get();
            bulletPoints = await generateBullets(
                'tailor', existingBullets,
                keywords, context, wordLimit, verbTracker
            );
            bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
        }
        bulletPoints = bulletPoints
            .filter(bp => !bulletTracker.isUsed(bp) ||
                        bulletTracker.canUseBulletInSection(bp, sectionType))
            .slice(0, targetBulletCount);
        bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);
        bulletList.empty();
        const seenPoints = new Set();
        bulletPoints.forEach(point => {
            const norm = point.toLowerCase().replace(/\s+/g, ' ').trim();
            if (seenPoints.has(norm)) return;
            seenPoints.add(norm);
            bulletTracker.addBullet(point, sectionType);
            verbTracker.addVerb(getFirstVerb(point), sectionType);
            const cleanPoint = point.replace(/^>>\s*/, '');
            bulletList.append(`<${bulletElementSelector}>${cleanPoint}</${bulletElementSelector}>`);
        });
    }
}

async function adjustSectionBullets($, sectionSelector, bulletSelector, targetCount, sectionType, bulletTracker, keywords, context, bulletCache) {
    const sections = $(sectionSelector);
    const bulletElementSelector = bulletSelector.replace(sectionSelector, '').trim().split(' ').pop() || 'li';
    sections.each((_, section) => {
        const bulletList = $(section).find('ul');
        if (bulletList.length === 0) {
            console.warn(`Cannot adjust bullets: List container not found in section ${sectionSelector}`);
            return;
        }
        const bullets = bulletList.find(bulletElementSelector);
        const currentCount = bullets.length;
        if (currentCount > targetCount) {
            bullets.slice(targetCount).remove();
        } else if (currentCount < targetCount) {
            const needed = targetCount - currentCount;
            const cachedBullets = bulletCache.getBulletsForSection(sectionType, needed * 2);
            const seen = new Set();
            const validBullets = cachedBullets
                .filter(bp => {
                    const norm = bp.toLowerCase().replace(/\s+/g, ' ').trim();
                    if (seen.has(norm) || bulletTracker.isUsed(bp)) return false;
                    seen.add(norm);
                    return true;
                })
                .slice(0, needed);
            validBullets.forEach(bullet => {
                bulletTracker.addBullet(bullet, sectionType);
                const cleanBullet = bullet.replace(/^>>\s*/, '');
                bulletList.append(`<${bulletElementSelector}>${cleanBullet}</${bulletElementSelector}>`);
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
            margin: 0;
            padding: 0;
        }
    `;
    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);
    const height = await checkPageHeight(page);
    const MAX_HEIGHT = 1056;
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

async function categorizeKeywords(keywords) {
    if (!keywords || keywords.length === 0) return null;
    const cacheKey = `categorize_v2_${keywords.sort().join(',')}`;
    if (lmCache.has(cacheKey)) {
        return lmCache.get(cacheKey);
    }
    try {
        const prompt = `Analyze the provided keywords for relevance to Applicant Tracking Systems (ATS) focused on technical roles. Your goal is to select ONLY the most impactful technical skills, tools, platforms, and specific methodologies.

HIGHEST PRIORITY: Under NO circumstances should you generate more than THREE (3) categories/sections for technical skills. If there would be more, you MUST combine or merge categories/types so that the total is 3 or fewer. This is the most important rule. Do NOT return 4 or more categories, even if it means grouping types together.

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

Based on these criteria, categorize the SELECTED keywords into NO MORE THAN THREE (3) categories. If you would have more, merge or combine them. Example groupings: (1) Languages, (2) Frameworks/Libraries/Tools, (3) Other Technical Skills. You may combine as needed, but never return more than 3 categories.

Return ONLY a JSON object containing the SELECTED and CATEGORIZED keywords. The keys should be the category names (maximum 3). The values should be arrays of the selected keywords. Every selected keyword MUST be placed in exactly one category. Do not include any keywords from the original list that fail the inclusion criteria or meet the exclusion criteria. Ensure the output is clean, valid JSON. Example format: {"Languages": ["Python", "SQL"], "Frameworks/Libraries/Tools": ["React"], "Other Technical Skills": ["AWS", "Git", "REST APIs"]}`;
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
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/{[\s\S]*?}/);
        const jsonString = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
        try {
            const categorized = JSON.parse(jsonString);
            lmCache.set(cacheKey, categorized);
            return categorized;
        } catch (jsonError) {
            console.error('Error parsing JSON from LLM response:', jsonError);
            const fallbackCategories = {
                "Languages": [],
                "Frameworks/Libraries": [],
                "Others": [],
                "Machine Learning Libraries": []
            };
            fallbackCategories["Others"] = keywords;
            lmCache.set(cacheKey, fallbackCategories);
            return fallbackCategories;
        }
    } catch (error) {
        console.error('Error categorizing keywords:', error.response?.data || error.message);
        return null;
    }
}

function updateSkillsSection($, keywords, selectors) {
    return new Promise(async (resolve, reject) => {
        try {
            const categorizedKeywords = await categorizeKeywords(keywords);
            if (!categorizedKeywords) {
                console.warn('Could not categorize keywords, skills section unchanged');
                resolve($);
                return;
            }
            const skillsSection = $(selectors.skillsSectionSelector);
            if (skillsSection.length === 0) {
                console.warn(`Skills section not found using selector: ${selectors.skillsSectionSelector}`);
                resolve($);
                return;
            }
            const categoryMapping = {
                "Languages": "Languages:",
                "Frameworks/Libraries": "Frameworks/Libraries:",
                "Others": "Others (APIs, Services, Protocols):",
                "Machine Learning Libraries": "Machine Learning Libraries:"
            };
            Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                    const keywordsList = categorizedKeywords[dataKey].join(', ');
                    const paragraph = skillsSection.find(`p > strong:contains("${htmlLabel}")`).parent('p');
                    if (paragraph.length > 0) {
                        paragraph.html(`<strong>${htmlLabel}</strong> ${keywordsList}`);
                    } else {
                        skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywordsList}</p>`);
                    }
                } else {
                     skillsSection.find(`p > strong:contains("${htmlLabel}")`).parent('p').remove();
                }
            });
            resolve($);
        } catch (error) {
            console.error('Error updating skills section:', error);
            resolve($);
        }
    });
}

async function parseResumeContent(htmlContent) {
    const cacheKey = `resumeContent_${generateHash(htmlContent)}`;
    if (lmCache.has(cacheKey)) {
        console.log('Returning cached resume content structure.');
        return lmCache.get(cacheKey);
    }
    
    console.log('Parsing resume content with OpenAI...');
    const prompt = `Analyze the following HTML content of a resume and extract its semantic structure. Parse the HTML to identify different sections (Job Experience, Projects, Education, Skills) and their contents.

Return ONLY a valid JSON object with the following structure:
- "jobEntries": Array of job experience entries, each containing:
  - "title": Job title (string)
  - "company": Company name (string)
  - "dates": Employment dates (string)
  - "bulletPoints": Array of bullet point texts exactly as they appear (array of strings)
  - "element": Unique identifier for this job entry (like a CSS selector or combination of attributes/text that can uniquely locate this entry)

- "projectEntries": Array of project entries, each containing:
  - "title": Project title (string)
  - "dates": Project dates if available (string or null)
  - "technologies": Technologies used, if explicitly listed (string or null)
  - "bulletPoints": Array of bullet point texts exactly as they appear (array of strings)
  - "element": Unique identifier for this project entry (CSS selector or textual pattern)

- "educationEntries": Array of education entries, each containing:
  - "institution": Name of educational institution (string)
  - "degree": Degree earned (string)
  - "dates": Study period (string)
  - "bulletPoints": Array of any bullet points or additional details (array of strings)
  - "element": Unique identifier for this education entry

- "skills": Object containing:
  - "allSkills": Array of all skills listed in the resume (array of strings)
  - "categorizedSkills": Object mapping skill categories to arrays of skills (if categories exist)
  - "element": CSS selector or identifier for the skills section

- "resumeStructure": Object containing:
  - "jobSectionIdentifier": A unique text pattern or element that identifies the job experience section
  - "projectSectionIdentifier": A unique text pattern or element that identifies the project section
  - "educationSectionIdentifier": A unique text pattern or element that identifies the education section
  - "skillsSectionIdentifier": A unique text pattern or element that identifies the skills section

Focus on extracting the EXACT text content as it appears in the HTML. For bullet points, preserve the exact wording.
The "element" fields should contain information that can be used to identify and locate the specific entries in the HTML (could be a CSS selector, a combination of text patterns, or other unique identifiers).

HTML Content to Analyze:
\`\`\`html
${htmlContent}
\`\`\`

Return ONLY the JSON object without any explanations or markdown formatting around it.`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are an AI assistant specialized in analyzing resume HTML to extract its semantic structure. You return only valid JSON matching the requested format. Extract the EXACT text content as it appears, especially for bullet points."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.2,
                max_tokens: 3000,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );
        
        const content = response.data.choices[0].message.content;
        try {
            const resumeContent = JSON.parse(content);
            const requiredKeys = [
                "jobEntries", "projectEntries", "educationEntries", 
                "skills", "resumeStructure"
            ];
            
            const hasAllKeys = requiredKeys.every(key => key in resumeContent);
            if (typeof resumeContent === 'object' && resumeContent !== null && hasAllKeys) {
                console.log('Successfully parsed resume content structure');
                lmCache.set(cacheKey, resumeContent);
                return resumeContent;
            } else {
                console.error('LLM returned invalid JSON structure or missing keys');
                return null;
            }
        } catch (jsonError) {
            console.error('Error parsing JSON from LLM response:', jsonError);
            return null;
        }
    } catch (error) {
        console.error('Error calling OpenAI API for resume parsing:', error.response?.data || error.message);
        return null;
    }
}

async function updateBulletPoints(
    $, 
    entry, 
    entryType, 
    keywords, 
    fullTailoring, 
    wordLimit, 
    bulletTracker, 
    verbTracker, 
    bulletCache,
    targetBulletCount
) {
    if (entryType === 'education') {
        console.log("Skipping bullet point generation for Education entry");
        return;
    }
    
    // Find this specific entry in the HTML by using the entry's element identifier
    let entryElement;
    try {
        // Try as CSS selector first
        entryElement = $(entry.element);
        
        // If that doesn't work, try looking for text patterns
        if (!entryElement.length) {
            // Look for entries containing both title and company/dates
            if (entryType === 'job') {
                entryElement = $(`*:contains("${entry.title}"):contains("${entry.company}")`).filter(function() {
                    return $(this).children().length > 0 && !$(this).parents('script, style').length;
                });
            } else if (entryType === 'project') {
                entryElement = $(`*:contains("${entry.title}")`).filter(function() {
                    return $(this).children().length > 0 && !$(this).parents('script, style').length;
                });
            }
        }
    } catch (e) {
        console.error(`Error finding entry element for ${entryType}:`, e);
        return;
    }
    
    if (!entryElement || !entryElement.length) {
        console.warn(`Could not find element for ${entryType} entry: ${entry.title}`);
        return;
    }
    
    // Now find or create the bullet list
    let bulletList = entryElement.find('ul');
    if (bulletList.length === 0) {
        // Try to find any list
        bulletList = entryElement.find('ol, dl');
        
        // If still no list, create a ul
        if (bulletList.length === 0) {
            // Find a good place to insert our list (after title/company/dates)
            const possibleContainer = entryElement.find('div, p, section').filter(function() {
                return $(this).children().length === 0 || 
                       ($(this).children('br').length > 0 && $(this).children().length === $(this).children('br').length);
            }).first();
            
            if (possibleContainer.length) {
                possibleContainer.append('<ul></ul>');
            } else {
                entryElement.append('<ul></ul>');
            }
            
            bulletList = entryElement.find('ul');
            if (bulletList.length === 0) {
                console.warn(`Could not find or create bullet list for ${entryType} entry: ${entry.title}`);
                return;
            }
        }
    }
    
    // Determine what element to use for bullets
    const existingBulletTag = entry.bulletPoints.length > 0 ? 
        bulletList.find('li, dt, dd').first().prop('tagName')?.toLowerCase() || 'li' : 'li';
    
    // Get bullet points either from cache or generate new ones
    let bulletPoints = bulletCache.getBulletsForSection(entryType, targetBulletCount);
    
    // If we have existing bullets and need full tailoring, use them as a base
    if (fullTailoring && entry.bulletPoints.length > 0) {
        bulletPoints = await generateBullets(
            'tailor', 
            entry.bulletPoints,
            keywords, 
            `for ${entryType === 'job' ? 'a job experience' : 'a project'}`, 
            wordLimit, 
            verbTracker
        );
        bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, entryType));
    }
    
    // Filter out used bullets
    bulletPoints = bulletPoints
        .filter(bp => !bulletTracker.isUsed(bp) || bulletTracker.canUseBulletInSection(bp, entryType))
        .slice(0, targetBulletCount);
    
    // Ensure verb variety
    bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, entryType, verbTracker);
    
    // Clear existing bullets and add new ones
    bulletList.empty();
    const seenPoints = new Set();
    
    bulletPoints.forEach(point => {
        const norm = point.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seenPoints.has(norm)) return;
        
        seenPoints.add(norm);
        bulletTracker.addBullet(point, entryType);
        verbTracker.addVerb(getFirstVerb(point), entryType);
        
        const cleanPoint = point.replace(/^>>\s*/, '');
        bulletList.append(`<${existingBulletTag}>${cleanPoint}</${existingBulletTag}>`);
    });
    
    return bulletPoints.length;
}

async function updateSkillsSectionContent($, skills, keywords) {
    return new Promise(async (resolve, reject) => {
        try {
            const categorizedKeywords = await categorizeKeywords(keywords);
            if (!categorizedKeywords) {
                console.warn('Could not categorize keywords, skills section unchanged');
                resolve($);
                return;
            }
            
            let skillsSection;
            try {
                // Try to find the skills section using the element identifier
                skillsSection = $(skills.element);
                
                // If that doesn't work, look for sections with skill-related text
                if (!skillsSection.length) {
                    skillsSection = $('section, div').filter(function() {
                        const text = $(this).text().toLowerCase();
                        return (text.includes('skills') || text.includes('technologies') || 
                                text.includes('expertise') || text.includes('proficiencies')) &&
                               !text.includes('soft skills') &&
                               $(this).children().length > 0;
                    });
                }
            } catch (e) {
                console.error('Error finding skills section:', e);
                // Fallback to looking for any section with "skills" in the title
                skillsSection = $('*:contains("Skills")').filter(function() {
                    return $(this).children().length > 0 && !$(this).parents('script, style').length;
                });
            }
            
            if (!skillsSection.length) {
                console.warn('Skills section not found');
                resolve($);
                return;
            }
            
            const categoryMapping = {
                "Languages": "Languages:",
                "Frameworks/Libraries": "Frameworks/Libraries:",
                "Others": "Others (APIs, Services, Protocols):",
                "Machine Learning Libraries": "Machine Learning Libraries:"
            };
            
            // Clear existing skills content while preserving the section structure
            skillsSection.find('p').remove();
            
            // Add new categorized skills
            Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                    const keywordsList = categorizedKeywords[dataKey].join(', ');
                    skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywordsList}</p>`);
                }
            });
            
            resolve($);
        } catch (error) {
            console.error('Error updating skills section:', error);
            resolve($);
        }
    });
}

async function updateResume(htmlContent, keywords, fullTailoring) {
    const resumeContent = await parseResumeContent(htmlContent);
    if (!resumeContent) {
        console.error("Failed to parse resume content. Aborting resume update.");
        return htmlContent;
    }
    
    const $ = cheerio.load(htmlContent);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Define initial bullet counts and minimum counts
    const INITIAL_BULLET_COUNT = 4;
    const MIN_BULLETS = 2;
    
    // Format keywords for use in generation
    const keywordString = fullTailoring ?
        keywords.join(', ') :
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');
    
    // Update skills section
    await updateSkillsSectionContent($, resumeContent.skills, keywords);
    
    // Pre-generate bullets for all sections
    await bulletCache.generateAllBullets($, keywords, 'resume section', 12, verbTracker);
    
    // Update job entries
    console.log(`Processing ${resumeContent.jobEntries.length} job entries`);
    for (const jobEntry of resumeContent.jobEntries) {
        await updateBulletPoints(
            $, jobEntry, 'job', keywordString, fullTailoring, 12,
            bulletTracker, verbTracker, bulletCache, INITIAL_BULLET_COUNT
        );
    }
    
    // Update project entries
    console.log(`Processing ${resumeContent.projectEntries.length} project entries`);
    for (const projectEntry of resumeContent.projectEntries) {
        await updateBulletPoints(
            $, projectEntry, 'project', keywordString, fullTailoring, 12,
            bulletTracker, verbTracker, bulletCache, INITIAL_BULLET_COUNT
        );
    }
    
    // Check page length and adjust if necessary
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;
    
    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;
        
        // Reduce bullet count and adjust
        currentBulletCount--;
        console.log(`Resume exceeds one page. Reducing bullets to ${currentBulletCount}`);
        
        // Adjust job entries
        for (const jobEntry of resumeContent.jobEntries) {
            const bulletLists = $(jobEntry.element).find('ul, ol, dl');
            bulletLists.each((_, list) => {
                const bullets = $(list).children('li, dt, dd');
                if (bullets.length > currentBulletCount) {
                    bullets.slice(currentBulletCount).remove();
                }
            });
        }
        
        // Adjust project entries
        for (const projectEntry of resumeContent.projectEntries) {
            const bulletLists = $(projectEntry.element).find('ul, ol, dl');
            bulletLists.each((_, list) => {
                const bullets = $(list).children('li, dt, dd');
                if (bullets.length > currentBulletCount) {
                    bullets.slice(currentBulletCount).remove();
                }
            });
        }
        
        attempts++;
    }
    
    // Log final counts
    const jobBullets = $('li, dt, dd').filter(function() {
        return resumeContent.jobEntries.some(job => 
            $(this).closest(job.element).length > 0);
    }).length;
    
    const projectBullets = $('li, dt, dd').filter(function() {
        return resumeContent.projectEntries.some(project => 
            $(this).closest(project.element).length > 0);
    }).length;
    
    const educationBullets = $('li, dt, dd').filter(function() {
        return resumeContent.educationEntries.some(edu => 
            $(this).closest(edu.element).length > 0);
    }).length;
    
    console.log(`Final bullet counts: Jobs=${jobBullets}, Projects=${projectBullets}, Education=${educationBullets}`);
    
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
        if (htmlContent.length < 100) {
            return res.status(400).send('Invalid HTML content: Content too short');
        }
        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);
        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));
    } catch (error) {
        console.error('Error in customizeResume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

// Export both parseResumeContent and getDynamicSelectors (for backward compatibility)
// getDynamicSelectors is kept as an alias to parseResumeContent
module.exports = { 
    customizeResume, 
    parseResumeContent,
    getDynamicSelectors: parseResumeContent 
};
