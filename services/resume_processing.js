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

async function applyHeuristicSelectors(htmlContent) {
    const $ = cheerio.load(htmlContent);
    const selectors = {
        jobSectionSelector: '',
        jobBulletSelector: '',
        projectSectionSelector: '',
        projectBulletSelector: '',
        educationSectionSelector: '',
        educationBulletSelector: '',
        skillsSectionSelector: ''
    };
    
    // Common section title keywords
    const keywords = {
        job: ['experience', 'work', 'employment', 'professional', 'career'],
        project: ['project', 'portfolio', 'sample', 'showcase'],
        education: ['education', 'academic', 'degree', 'university', 'school', 'training'],
        skills: ['skill', 'technology', 'tool', 'language', 'expertise', 'proficiency']
    };
    
    // Look for section titles with common keywords
    $('h1, h2, h3, h4, h5, h6, div[class*="title"], div[class*="heading"], span[class*="title"]').each((_, el) => {
        const text = $(el).text().trim().toLowerCase();
        
        // Check for job section
        if (!selectors.jobSectionSelector && keywords.job.some(keyword => text.includes(keyword))) {
            const parentSelector = getParentElementSelector($, el);
            if (parentSelector) {
                selectors.jobSectionSelector = parentSelector;
                selectors.jobBulletSelector = `${parentSelector} li`;
            }
        }
        
        // Check for project section
        if (!selectors.projectSectionSelector && keywords.project.some(keyword => text.includes(keyword))) {
            const parentSelector = getParentElementSelector($, el);
            if (parentSelector) {
                selectors.projectSectionSelector = parentSelector;
                selectors.projectBulletSelector = `${parentSelector} li`;
            }
        }
        
        // Check for education section
        if (!selectors.educationSectionSelector && keywords.education.some(keyword => text.includes(keyword))) {
            const parentSelector = getParentElementSelector($, el);
            if (parentSelector) {
                selectors.educationSectionSelector = parentSelector;
                selectors.educationBulletSelector = `${parentSelector} li`;
            }
        }
        
        // Check for skills section
        if (!selectors.skillsSectionSelector && keywords.skills.some(keyword => text.includes(keyword))) {
            const parentSelector = getParentElementSelector($, el);
            if (parentSelector) {
                selectors.skillsSectionSelector = parentSelector;
            }
        }
    });
    
    // If we still don't have all selectors, look for structural patterns
    if (!selectors.jobSectionSelector || !selectors.projectSectionSelector || !selectors.educationSectionSelector) {
        // Look for div elements with dates (common in resume sections)
        $('div, section').each((_, el) => {
            const text = $(el).text();
            const hasDate = /\b(19|20)\d{2}\b[-–—](\b(19|20)\d{2}\b|present|current|now)/i.test(text);
            
            if (hasDate) {
                // Check for common words to disambiguate sections
                const lowerText = text.toLowerCase();
                
                if (!selectors.jobSectionSelector && keywords.job.some(keyword => lowerText.includes(keyword))) {
                    selectors.jobSectionSelector = getElementSelector($, el);
                    selectors.jobBulletSelector = `${selectors.jobSectionSelector} li`;
                } else if (!selectors.projectSectionSelector && keywords.project.some(keyword => lowerText.includes(keyword))) {
                    selectors.projectSectionSelector = getElementSelector($, el);
                    selectors.projectBulletSelector = `${selectors.projectSectionSelector} li`;
                } else if (!selectors.educationSectionSelector && keywords.education.some(keyword => lowerText.includes(keyword))) {
                    selectors.educationSectionSelector = getElementSelector($, el);
                    selectors.educationBulletSelector = `${selectors.educationSectionSelector} li`;
                } else if (!selectors.jobSectionSelector && !selectors.projectSectionSelector) {
                    // If we haven't found a job section yet, this date-containing section is likely job experience
                    selectors.jobSectionSelector = getElementSelector($, el);
                    selectors.jobBulletSelector = `${selectors.jobSectionSelector} li`;
                }
            }
        });
    }
    
    // Create generic selectors if specific ones weren't found
    if (!selectors.jobSectionSelector) {
        selectors.jobSectionSelector = 'div.section:has(div.section-title:contains("Experience")), div.section:has(div.section-title:contains("Work"))';
        selectors.jobBulletSelector = `${selectors.jobSectionSelector} li`;
    }
    
    if (!selectors.projectSectionSelector) {
        selectors.projectSectionSelector = 'div.section:has(div.section-title:contains("Project"))';
        selectors.projectBulletSelector = `${selectors.projectSectionSelector} li`;
    }
    
    if (!selectors.educationSectionSelector) {
        selectors.educationSectionSelector = 'div.section:has(div.section-title:contains("Education"))';
        selectors.educationBulletSelector = `${selectors.educationSectionSelector} span, ${selectors.educationSectionSelector} li`;
    }
    
    if (!selectors.skillsSectionSelector) {
        selectors.skillsSectionSelector = 'div.section:has(div.section-title:contains("Skill"))';
    }
    
    // Check if selectors actually match elements
    ['jobSectionSelector', 'projectSectionSelector', 'educationSectionSelector', 'skillsSectionSelector'].forEach(key => {
        try {
            const count = $(selectors[key]).length;
            console.log(`Heuristic ${key} matched ${count} elements`);
            
            if (count === 0) {
                // If no matches, try a more generic fallback
                if (key === 'jobSectionSelector') {
                    selectors[key] = 'div:has(h1:contains("Experience")), div:has(h2:contains("Experience")), div:has(h3:contains("Experience")), section:has(h1:contains("Experience")), section:has(h2:contains("Experience"))';
                    selectors.jobBulletSelector = `${selectors[key]} li`;
                } else if (key === 'projectSectionSelector') {
                    selectors[key] = 'div:has(h1:contains("Project")), div:has(h2:contains("Project")), div:has(h3:contains("Project")), section:has(h1:contains("Project")), section:has(h2:contains("Project"))';
                    selectors.projectBulletSelector = `${selectors[key]} li`;
                } else if (key === 'educationSectionSelector') {
                    selectors[key] = 'div:has(h1:contains("Education")), div:has(h2:contains("Education")), div:has(h3:contains("Education")), section:has(h1:contains("Education")), section:has(h2:contains("Education"))';
                    selectors.educationBulletSelector = `${selectors[key]} li, ${selectors[key]} span`;
                } else if (key === 'skillsSectionSelector') {
                    selectors[key] = 'div:has(h1:contains("Skill")), div:has(h2:contains("Skill")), div:has(h3:contains("Skill")), section:has(h1:contains("Skill")), section:has(h2:contains("Skill"))';
                }
            }
        } catch (error) {
            console.error(`Error checking heuristic selector ${key}:`, error);
        }
    });
    
    return selectors;
}

function getParentElementSelector($, element) {
    const parent = $(element).parent();
    if (!parent || !parent.length) return null;
    
    const tag = parent.prop('tagName')?.toLowerCase();
    if (!tag) return null;
    
    const id = parent.attr('id');
    const classes = parent.attr('class')?.split(/\s+/).filter(Boolean) || [];
    
    if (id) return `${tag}#${id}`;
    if (classes.length) return `${tag}.${classes.join('.')}`;
    return null;
}

function getElementSelector($, element) {
    const tag = element.tagName.toLowerCase();
    const id = $(element).attr('id');
    const classes = $(element).attr('class')?.split(/\s+/).filter(Boolean) || [];
    
    if (id) return `${tag}#${id}`;
    if (classes.length) return `${tag}.${classes.join('.')}`;
    
    // If no id or class, create a more specific selector based on text content
    const headings = $(element).find('h1, h2, h3, h4, h5, h6').first();
    if (headings.length) {
        const headingText = headings.text().trim();
        if (headingText) {
            return `${tag}:has(${headings.prop('tagName').toLowerCase()}:contains("${headingText}"))`;
        }
    }
    
    return tag;
}

async function createSmartFallbackSelectors(htmlContent) {
    // Create a two-tiered fallback approach:
    // 1. First try the heuristic-based approach (fast)
    // 2. If that fails, use a generic resume section identification approach
    
    try {
        // Try the heuristic-based approach first
        const heuristicSelectors = await applyHeuristicSelectors(htmlContent);
        
        // Verify if the heuristic selectors actually matched elements
        const $ = cheerio.load(htmlContent);
        let heuristicsValid = true;
        
        for (const key of ['jobSectionSelector', 'projectSectionSelector', 'educationSectionSelector', 'skillsSectionSelector']) {
            const elements = $(heuristicSelectors[key]);
            if (elements.length === 0) {
                heuristicsValid = false;
                console.warn(`Heuristic selector ${key} didn't match any elements: ${heuristicSelectors[key]}`);
                break;
            }
        }
        
        if (heuristicsValid) {
            console.log('Using heuristic-based selectors for fallback');
            return heuristicSelectors;
        }
        
        // If heuristics failed, use generic selectors based on common resume structural patterns
        console.log('Heuristic selectors failed, using generic fallback selectors');
        
        // Examine the resume structure to identify common patterns
        const sections = [];
        $('div, section').each((_, el) => {
            // Skip tiny sections
            if ($(el).text().trim().length < 50) return;
            
            const hasHeading = $(el).find('h1, h2, h3, h4, h5, h6, div[class*="title"]').length > 0;
            const hasList = $(el).find('ul, ol').length > 0;
            const hasDatePattern = /\b(19|20)\d{2}\b[-–—](\b(19|20)\d{2}\b|present|current|now)/i.test($(el).text());
            
            if ((hasHeading && hasList) || (hasHeading && hasDatePattern)) {
                sections.push({
                    element: el,
                    hasHeading,
                    hasList,
                    hasDatePattern,
                    content: $(el).text().trim().substring(0, 100),
                    selector: getElementSelector($, el)
                });
            }
        });
        
        // Sort sections by position in document
        sections.sort((a, b) => {
            const posA = $(a.element).offset()?.top || 0;
            const posB = $(b.element).offset()?.top || 0;
            return posA - posB;
        });
        
        // Classify sections based on content and position
        const genericSelectors = {
            jobSectionSelector: '',
            jobBulletSelector: '',
            projectSectionSelector: '',
            projectBulletSelector: '',
            educationSectionSelector: '',
            educationBulletSelector: '',
            skillsSectionSelector: ''
        };
        
        if (sections.length >= 3) {
            // Typical case: Experience, Projects, Education (in some order)
            // Use position-based heuristics
            
            // First section with date pattern is likely Experience (job)
            const jobSection = sections.find(s => s.hasDatePattern);
            if (jobSection) {
                genericSelectors.jobSectionSelector = jobSection.selector;
                genericSelectors.jobBulletSelector = `${jobSection.selector} li`;
            } else {
                genericSelectors.jobSectionSelector = sections[0].selector;
                genericSelectors.jobBulletSelector = `${sections[0].selector} li`;
            }
            
            // Last section is often education
            genericSelectors.educationSectionSelector = sections[sections.length - 1].selector;
            genericSelectors.educationBulletSelector = `${sections[sections.length - 1].selector} li, ${sections[sections.length - 1].selector} span`;
            
            // Middle sections could be projects
            if (sections.length > 2) {
                genericSelectors.projectSectionSelector = sections[1].selector;
                genericSelectors.projectBulletSelector = `${sections[1].selector} li`;
            }
            
            // Look for skills section - typically has lists but no dates
            const skillSection = sections.find(s => {
                const text = $(s.element).text().toLowerCase();
                return text.includes('skill') || text.includes('technologies') || text.includes('proficiency');
            });
            
            if (skillSection) {
                genericSelectors.skillsSectionSelector = skillSection.selector;
            } else {
                // Look for any section with bullet points but no dates as a fallback
                const fallbackSkillSection = sections.find(s => s.hasList && !s.hasDatePattern);
                if (fallbackSkillSection) {
                    genericSelectors.skillsSectionSelector = fallbackSkillSection.selector;
                }
            }
        } else if (sections.length > 0) {
            // Limited sections - just make a best guess
            genericSelectors.jobSectionSelector = sections[0].selector;
            genericSelectors.jobBulletSelector = `${sections[0].selector} li`;
            
            if (sections.length > 1) {
                genericSelectors.educationSectionSelector = sections[sections.length - 1].selector;
                genericSelectors.educationBulletSelector = `${sections[sections.length - 1].selector} li, ${sections[sections.length - 1].selector} span`;
            }
        }
        
        // If we still don't have all needed selectors, use very generic ones
        if (!genericSelectors.jobSectionSelector) {
            genericSelectors.jobSectionSelector = 'div, section';
            genericSelectors.jobBulletSelector = 'div li, section li';
        }
        
        if (!genericSelectors.educationSectionSelector) {
            genericSelectors.educationSectionSelector = 'div:last-of-type, section:last-of-type';
            genericSelectors.educationBulletSelector = 'div:last-of-type li, section:last-of-type li, div:last-of-type span, section:last-of-type span';
        }
        
        if (!genericSelectors.projectSectionSelector) {
            // Use a middle section if available
            const middleIndex = Math.floor(sections.length / 2);
            if (middleIndex < sections.length) {
                genericSelectors.projectSectionSelector = sections[middleIndex].selector;
                genericSelectors.projectBulletSelector = `${sections[middleIndex].selector} li`;
            } else {
                genericSelectors.projectSectionSelector = genericSelectors.jobSectionSelector; // Fallback to same as jobs
                genericSelectors.projectBulletSelector = genericSelectors.jobBulletSelector;
            }
        }
        
        if (!genericSelectors.skillsSectionSelector) {
            genericSelectors.skillsSectionSelector = 'div:has(h1:contains("Skill")), div:has(h2:contains("Skill")), div:has(h3:contains("Skill")), div:has(h4:contains("Skill")), section:has(h1:contains("Skill")), section:has(h2:contains("Skill"))';
        }
        
        console.log('Using generic fallback selectors');
        return genericSelectors;
    } catch (error) {
        console.error('Error creating smart fallback selectors:', error);
        
        // Last-resort ultra-generic selectors
        return {
            jobSectionSelector: 'div, section',
            jobBulletSelector: 'li',
            projectSectionSelector: 'div, section',
            projectBulletSelector: 'li',
            educationSectionSelector: 'div, section',
            educationBulletSelector: 'li, span',
            skillsSectionSelector: 'div, section'
        };
    }
}

async function updateResume(htmlContent, keywords, fullTailoring) {
    const selectors = await getDynamicSelectors(htmlContent);
    if (!selectors || Object.keys(selectors).length === 0) {
        console.error("Failed to get dynamic selectors. Attempting to use fallback selectors.");
        const fallbackSelectors = await createSmartFallbackSelectors(htmlContent);
        if (!fallbackSelectors) {
            console.error("All selector methods failed. Returning original content.");
            return htmlContent;
        }
        console.log("Using fallback selectors:", fallbackSelectors);
        return await processResumeWithSelectors(htmlContent, fallbackSelectors, keywords, fullTailoring);
    }
    
    // Initial validity check
    let selectorsValid = true;
    const $ = cheerio.load(htmlContent);
    
    for (const key of ["jobSectionSelector", "jobBulletSelector", "projectSectionSelector", 
                       "projectBulletSelector", "educationSectionSelector", "educationBulletSelector",
                       "skillsSectionSelector"]) {
        try {
            const count = $(selectors[key]).length;
            if (count === 0) {
                console.warn(`Selector ${key} didn't match any elements: ${selectors[key]}`);
                selectorsValid = false;
            }
        } catch (error) {
            console.error(`Error with selector ${key}:`, error);
            selectorsValid = false;
        }
    }
    
    if (!selectorsValid) {
        console.warn("Some dynamic selectors are invalid. Attempting to use fallback selectors.");
        const fallbackSelectors = await createSmartFallbackSelectors(htmlContent);
        console.log("Using fallback selectors instead:", fallbackSelectors);
        return await processResumeWithSelectors(htmlContent, fallbackSelectors, keywords, fullTailoring);
    }
    
    // Check for section overlap
    const jobElements = $(selectors.jobSectionSelector);
    const eduElements = $(selectors.educationSectionSelector);
    const projectElements = $(selectors.projectSectionSelector);
    
    let hasOverlap = false;
    
    // Check each job element against education and project elements
    jobElements.each((_, jobEl) => {
        eduElements.each((_, eduEl) => {
            if (jobEl === eduEl) {
                hasOverlap = true;
                console.warn("Overlap detected between job and education selectors");
                return false;
            }
        });
        
        projectElements.each((_, projEl) => {
            if (jobEl === projEl) {
                hasOverlap = true;
                console.warn("Overlap detected between job and project selectors");
                return false;
            }
        });
    });
    
    // Check education elements against project elements
    eduElements.each((_, eduEl) => {
        projectElements.each((_, projEl) => {
            if (eduEl === projEl) {
                hasOverlap = true;
                console.warn("Overlap detected between education and project selectors");
                return false;
            }
        });
    });
    
    if (hasOverlap) {
        console.warn("Selector overlap detected. Attempting to use fallback selectors.");
        const fallbackSelectors = await createSmartFallbackSelectors(htmlContent);
        console.log("Using non-overlapping fallback selectors:", fallbackSelectors);
        return await processResumeWithSelectors(htmlContent, fallbackSelectors, keywords, fullTailoring);
    }
    
    // If all checks pass, proceed with the dynamic selectors
    return await processResumeWithSelectors(htmlContent, selectors, keywords, fullTailoring);
}

async function processResumeWithSelectors(htmlContent, selectors, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const sectionWordCounts = getSectionWordCounts($, selectors);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    const originalBullets = extractOriginalBullets($, selectors);
    await updateSkillsSection($, keywords, selectors);
    const INITIAL_BULLET_COUNT = 4;
    const MIN_BULLETS = 2;
    const keywordString = fullTailoring ?
        keywords.join(', ') :
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');
    const allBullets = await bulletCache.generateAllBullets($, keywords, 'resume section', 12, verbTracker);
    const sections = [
        { selector: selectors.jobSectionSelector, bulletSelector: selectors.jobBulletSelector, type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { selector: selectors.projectSectionSelector, bulletSelector: selectors.projectBulletSelector, type: 'project', context: 'for a project', bullets: originalBullets.project },
        { selector: selectors.educationSectionSelector, bulletSelector: selectors.educationBulletSelector, type: 'education', context: 'for education', bullets: originalBullets.education }
    ];
    const sectionsToProcessBullets = sections.filter(section => section.type !== 'education');
    console.log(`Processing bullets for sections: ${sectionsToProcessBullets.map(s => s.type).join(', ')}`);
    for (const section of sectionsToProcessBullets) {
        await updateResumeSection(
            $, section.selector, section.bulletSelector,
            keywordString, section.context,
            fullTailoring, 12,
            bulletTracker, section.type, section.bullets,
            INITIAL_BULLET_COUNT, verbTracker, bulletCache
        );
    }
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;
    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;
        currentBulletCount--;
        for (const section of sectionsToProcessBullets) {
            await adjustSectionBullets(
                $, section.selector, section.bulletSelector,
                currentBulletCount, section.type, bulletTracker,
                keywordString, section.context, bulletCache
            );
        }
        attempts++;
    }
    const finalJobBullets = $(selectors.jobBulletSelector).length;
    const finalProjectBullets = $(selectors.projectBulletSelector).length;
    const finalEducationBullets = $(selectors.educationBulletSelector).length;
    console.log(`Final bullet counts: Jobs=${finalJobBullets}, Projects=${finalProjectBullets}, Education=${finalEducationBullets}`);
    return $.html();
}

async function extractResumeStructure(htmlContent) {
    const $ = cheerio.load(htmlContent);
    const structure = {
        allSections: [],
        potentialSectionTitles: [],
        bulletPointContainers: [],
        headings: [],
        semanticClues: []
    };
    
    // Analyze headings and possible section titles
    $('h1, h2, h3, h4, h5, h6, div[class*="title"], div[class*="heading"], span[class*="title"], span[class*="heading"]').each((_, el) => {
        const text = $(el).text().trim();
        const tag = el.tagName.toLowerCase();
        const classNames = $(el).attr('class') || '';
        const id = $(el).attr('id') || '';
        
        structure.headings.push({
            text,
            tag,
            classNames,
            id,
            path: getElementPath($, el)
        });
        
        // Identify potential section titles based on common resume sections
        const keywords = ['experience', 'work', 'employment', 'job', 'project', 'education', 'skill', 'qualification', 'certification'];
        for (const keyword of keywords) {
            if (text.toLowerCase().includes(keyword)) {
                structure.potentialSectionTitles.push({
                    text,
                    keyword,
                    tag,
                    classNames,
                    id,
                    path: getElementPath($, el)
                });
                break;
            }
        }
    });
    
    // Analyze sections that may be job entries, projects, or education
    $('div, section, article').each((_, el) => {
        // Get all the text within this section to analyze content
        const allText = $(el).text().trim();
        if (allText.length < 10) return; // Skip very small sections
        
        const classNames = $(el).attr('class') || '';
        const id = $(el).attr('id') || '';
        
        // Look for date patterns typical in resumes
        const hasDatePattern = /\b(19|20)\d{2}\b[-–—](\b(19|20)\d{2}\b|present|current|now)/i.test(allText);
        
        // Look for bullet points or lists
        const hasBulletPoints = $(el).find('ul, ol, li').length > 0;
        
        // Add to sections if it has characteristics of a resume section
        if (hasDatePattern || hasBulletPoints) {
            structure.allSections.push({
                hasDatePattern,
                hasBulletPoints,
                classNames,
                id,
                path: getElementPath($, el),
                contentPreview: allText.substring(0, 100).replace(/\s+/g, ' ') + '...'
            });
        }
    });
    
    // Analyze bullet point containers specifically
    $('ul, ol, div > li, section > li').each((_, el) => {
        const listItems = $(el).find('li').length;
        if (listItems > 0 || el.tagName.toLowerCase() === 'li') {
            const parentEl = $(el).parent().get(0);
            structure.bulletPointContainers.push({
                tagName: el.tagName.toLowerCase(),
                listItems: listItems || 1,
                classNames: $(el).attr('class') || '',
                parentClassNames: parentEl ? ($(parentEl).attr('class') || '') : '',
                path: getElementPath($, el)
            });
        }
    });
    
    // Extract semantic clues from the HTML
    // Look for specific elements or attributes that might indicate resume sections
    $('[class*="experience"], [class*="job"], [class*="work"], [class*="project"], [class*="education"], [class*="skill"]').each((_, el) => {
        const classNames = $(el).attr('class');
        const text = $(el).text().trim().substring(0, 50);
        structure.semanticClues.push({
            type: 'class',
            value: classNames,
            textPreview: text,
            path: getElementPath($, el)
        });
    });
    
    $('[id*="experience"], [id*="job"], [id*="work"], [id*="project"], [id*="education"], [id*="skill"]').each((_, el) => {
        const id = $(el).attr('id');
        const text = $(el).text().trim().substring(0, 50);
        structure.semanticClues.push({
            type: 'id',
            value: id,
            textPreview: text,
            path: getElementPath($, el)
        });
    });
    
    return structure;
}

function getElementPath($, element) {
    const path = [];
    let current = element;
    
    while (current && current.type === 'tag') {
        const tag = current.tagName.toLowerCase();
        const classNames = $(current).attr('class') || '';
        const id = $(current).attr('id') || '';
        
        let selector = tag;
        if (id) selector += `#${id}`;
        if (classNames) {
            const classes = classNames.split(/\s+/).filter(Boolean);
            selector += classes.map(c => `.${c}`).join('');
        }
        
        path.unshift(selector);
        current = current.parent;
    }
    
    return path.join(' > ');
}

async function identifyResumeComponents(htmlStructure) {
    try {
        const prompt = `You are a specialized resume HTML analyzer. Analyze the provided HTML structure of a resume to identify the most appropriate CSS selectors for key resume sections. The structure information is provided as JSON with detailed analysis of the HTML.

Your mission is to find the most reliable, specific CSS selectors that uniquely identify each resume section type, even for non-standard resume formats.

First, study these HTML structure details carefully. This is parsed information about a real resume's HTML:
${JSON.stringify(htmlStructure, null, 2)}

STEP 1: ANALYZE RESUME STRUCTURE
Study the headings, section titles, semantic clues, and content to understand the structure:
- Look for clear patterns in headings that indicate section types (Experience, Education, Skills)
- Analyze semantic clues (class and id names) that reveal the document structure
- Examine how bullet points are organized within different sections
- Identify distinguishing features between different section types

STEP 2: DEVELOP ROBUST SELECTORS STRATEGY
Focus on developing a selector strategy that:
1. Is robust across diverse resume formats
2. Handles non-standard naming conventions
3. Uses semantic meaning when possible (classes/ids with meaningful names)
4. Falls back to structural patterns when semantic clues are missing
5. Utilizes contextual clues (:contains, proximity to headings)
6. NEVER creates selectors that might overlap between different section types

STEP 3: CREATE SPECIFIC SELECTORS
Create highly specific selectors for each required section:

Return a valid JSON object with these keys and CSS selector strings as values:
- "jobSectionSelector": Containers for job experience entries ONLY
- "jobBulletSelector": Bullet points within job containers (descendant selector)
- "projectSectionSelector": Containers for project entries ONLY
- "projectBulletSelector": Bullet points within project containers (descendant selector)
- "educationSectionSelector": Containers for education entries ONLY
- "educationBulletSelector": Bullet points within education containers (descendant selector)
- "skillsSectionSelector": Container for technical skills sections

CRITICAL REQUIREMENTS:
1. NEVER create selectors that will select elements from the wrong section type
2. Use :has() and :contains() to create disambiguating selectors when needed
3. When section titles are available, always reference them in selectors
4. All bullet selectors must be descendants of their section selectors
5. Favor more specific selectors over generic ones

Include a "selectorRationale" field with brief explanations of how you developed the selectors and why they should be reliable.

Return ONLY a JSON object with no markdown formatting.`;

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume HTML analyzer that returns only valid JSON. You must create CSS selectors that precisely identify different resume sections without any overlap between sections."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.2,
                max_tokens: 1200,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );
        
        return JSON.parse(response.data.choices[0].message.content);
    } catch (error) {
        console.error('Error identifying resume components:', error.response?.data || error.message);
        return null;
    }
}

async function getDynamicSelectors(htmlContent) {
    const cacheKey = `dynamicSelectors_${generateHash(htmlContent)}`;
    if (lmCache.has(cacheKey)) {
        console.log('Returning cached dynamic selectors.');
        return lmCache.get(cacheKey);
    }
    
    console.log('Analyzing resume structure...');
    
    try {
        // Step 1: Extract the HTML structure with semantic analysis
        const htmlStructure = await extractResumeStructure(htmlContent);
        
        // Step 2: Use the language model to identify components from structure
        const identifiedComponents = await identifyResumeComponents(htmlStructure);
        
        if (!identifiedComponents) {
            console.error('Failed to identify resume components using structured analysis');
            // Fall back to direct HTML analysis as a backup approach
            return await getLegacyDynamicSelectors(htmlContent);
        }
        
        // Step 3: Validate the identified selectors with a quick check
        const $ = cheerio.load(htmlContent);
        const requiredKeys = [
            "jobSectionSelector", "jobBulletSelector",
            "projectSectionSelector", "projectBulletSelector",
            "educationSectionSelector", "educationBulletSelector",
            "skillsSectionSelector"
        ];
        
        // Check if all selectors exist and find at least one element
        const validationResults = {};
        let allValid = true;
        
        for (const key of requiredKeys) {
            try {
                const selector = identifiedComponents[key];
                if (!selector) {
                    validationResults[key] = { valid: false, reason: 'Missing selector' };
                    allValid = false;
                    continue;
                }
                
                const elements = $(selector);
                validationResults[key] = { 
                    valid: elements.length > 0, 
                    count: elements.length,
                    reason: elements.length > 0 ? 'Found elements' : 'No elements found' 
                };
                
                if (elements.length === 0) {
                    allValid = false;
                }
            } catch (error) {
                validationResults[key] = { valid: false, reason: `Invalid selector: ${error.message}` };
                allValid = false;
            }
        }
        
        // Check for section overlap - make sure job selectors don't match education and vice versa
        const jobElements = $(identifiedComponents.jobSectionSelector);
        const eduElements = $(identifiedComponents.educationSectionSelector);
        const projectElements = $(identifiedComponents.projectSectionSelector);
        
        let hasOverlap = false;
        
        // Check each job element against education and project elements
        jobElements.each((_, jobEl) => {
            eduElements.each((_, eduEl) => {
                if (jobEl === eduEl) {
                    hasOverlap = true;
                    validationResults.overlap = validationResults.overlap || [];
                    validationResults.overlap.push('Job and Education selectors overlap');
                    return false; // break the inner loop
                }
            });
            
            projectElements.each((_, projEl) => {
                if (jobEl === projEl) {
                    hasOverlap = true;
                    validationResults.overlap = validationResults.overlap || [];
                    validationResults.overlap.push('Job and Project selectors overlap');
                    return false; // break the inner loop
                }
            });
        });
        
        // Check education elements against project elements
        eduElements.each((_, eduEl) => {
            projectElements.each((_, projEl) => {
                if (eduEl === projEl) {
                    hasOverlap = true;
                    validationResults.overlap = validationResults.overlap || [];
                    validationResults.overlap.push('Education and Project selectors overlap');
                    return false; // break the inner loop
                }
            });
        });
        
        console.log('Selector validation results:', validationResults);
        
        if (allValid && !hasOverlap) {
            console.log('All selectors are valid and have no overlap');
            const finalSelectors = {
                ...identifiedComponents,
                _validation: validationResults
            };
            delete finalSelectors.selectorRationale; // Remove this from what we cache
            lmCache.set(cacheKey, finalSelectors);
            return finalSelectors;
        } else {
            console.warn('Some selectors are invalid or have overlap, attempting remediation');
            
            // Try to fix overlapping selectors
            if (hasOverlap) {
                const fixedSelectors = await remedyOverlappingSelectors(htmlContent, identifiedComponents, validationResults);
                if (fixedSelectors) {
                    console.log('Successfully remediated overlapping selectors');
                    lmCache.set(cacheKey, fixedSelectors);
                    return fixedSelectors;
                }
            }
            
            // Fall back to legacy approach if remediation failed
            console.log('Falling back to legacy selector approach');
            return await getLegacyDynamicSelectors(htmlContent);
        }
    } catch (error) {
        console.error('Error in dynamic selector analysis:', error);
        return await getLegacyDynamicSelectors(htmlContent);
    }
}

async function remedyOverlappingSelectors(htmlContent, identifiedComponents, validationResults) {
    const $ = cheerio.load(htmlContent);
    
    // Look for section title texts to create more specific selectors
    const sectionTitles = {
        job: ['experience', 'employment', 'work history', 'work experience', 'professional experience'],
        education: ['education', 'academic', 'degree', 'university', 'school'],
        project: ['project', 'portfolio', 'work sample']
    };
    
    const fixedSelectors = {...identifiedComponents};
    
    // Try to fix job section selector if needed
    if (validationResults.overlap && validationResults.overlap.some(msg => msg.includes('Job'))) {
        for (const title of sectionTitles.job) {
            const selector = `div:has(h1:contains("${title}"), h2:contains("${title}"), h3:contains("${title}"), div:contains("${title}")), section:has(h1:contains("${title}"), h2:contains("${title}"), h3:contains("${title}"), div:contains("${title}"))`;
            const elements = $(selector);
            if (elements.length > 0) {
                fixedSelectors.jobSectionSelector = selector;
                fixedSelectors.jobBulletSelector = `${selector} li`;
                break;
            }
        }
    }
    
    // Try to fix education section selector if needed
    if (validationResults.overlap && validationResults.overlap.some(msg => msg.includes('Education'))) {
        for (const title of sectionTitles.education) {
            const selector = `div:has(h1:contains("${title}"), h2:contains("${title}"), h3:contains("${title}"), div:contains("${title}")), section:has(h1:contains("${title}"), h2:contains("${title}"), h3:contains("${title}"), div:contains("${title}"))`;
            const elements = $(selector);
            if (elements.length > 0) {
                fixedSelectors.educationSectionSelector = selector;
                fixedSelectors.educationBulletSelector = `${selector} li`;
                break;
            }
        }
    }
    
    // Try to fix project section selector if needed
    if (validationResults.overlap && validationResults.overlap.some(msg => msg.includes('Project'))) {
        for (const title of sectionTitles.project) {
            const selector = `div:has(h1:contains("${title}"), h2:contains("${title}"), h3:contains("${title}"), div:contains("${title}")), section:has(h1:contains("${title}"), h2:contains("${title}"), h3:contains("${title}"), div:contains("${title}"))`;
            const elements = $(selector);
            if (elements.length > 0) {
                fixedSelectors.projectSectionSelector = selector;
                fixedSelectors.projectBulletSelector = `${selector} li`;
                break;
            }
        }
    }
    
    // Check if the fixed selectors have resolved the overlap
    const jobElements = $(fixedSelectors.jobSectionSelector);
    const eduElements = $(fixedSelectors.educationSectionSelector);
    const projectElements = $(fixedSelectors.projectSectionSelector);
    
    let hasOverlap = false;
    jobElements.each((_, jobEl) => {
        eduElements.each((_, eduEl) => {
            if (jobEl === eduEl) hasOverlap = true;
        });
        projectElements.each((_, projEl) => {
            if (jobEl === projEl) hasOverlap = true;
        });
    });
    
    eduElements.each((_, eduEl) => {
        projectElements.each((_, projEl) => {
            if (eduEl === projEl) hasOverlap = true;
        });
    });
    
    return hasOverlap ? null : fixedSelectors;
}

async function getLegacyDynamicSelectors(htmlContent) {
    console.log('Using legacy approach for dynamic selectors');
    const prompt = `Analyze the following HTML content and identify the most appropriate, specific CSS selectors for the key resume sections. For each section type, provide selectors that uniquely identify that section type only (job selectors should not match education sections and vice versa).

Return ONLY a valid JSON object with the following keys and their corresponding CSS selector strings as values:
- "jobSectionSelector": The container(s) for distinct job experience entries ONLY. These must NOT match education entries.
- "jobBulletSelector": The list items (e.g., 'li' or similar) functioning as bullet points *within* the job experience containers. Use a descendant selector (e.g., 'jobSectionSelector li').
- "projectSectionSelector": The container(s) for distinct project entries ONLY. These must NOT match education entries.
- "projectBulletSelector": The list items (e.g., 'li') *within* the project containers. Use a descendant selector.
- "educationSectionSelector": The container(s) for distinct education entries ONLY. These must NOT match job or project entries.
- "educationBulletSelector": The list items (e.g., 'li') *within* the education containers. Use a descendant selector.
- "skillsSectionSelector": The main container/element holding the technical skills or keywords list.

Focus on creating selectors that DO NOT overlap between different section types. For example, if both job and education sections use the same class (e.g., ".entry"), add distinguishing selectors like: ".section:has(.section-title:contains('Experience')) .entry" for jobs and ".section:has(.section-title:contains('Education')) .entry" for education.

Example Output Format (Selectors will vary based on HTML):
{
  "jobSectionSelector": ".section:has(.section-title:contains('Experience')) .entry",
  "jobBulletSelector": ".section:has(.section-title:contains('Experience')) .entry ul > li",
  "projectSectionSelector": ".section:has(.section-title:contains('Projects')) .project-item",
  "projectBulletSelector": ".section:has(.section-title:contains('Projects')) .project-item li.bullet",
  "educationSectionSelector": ".section:has(.section-title:contains('Education')) .entry",
  "educationBulletSelector": ".section:has(.section-title:contains('Education')) .entry .details li",
  "skillsSectionSelector": "#technical-skills-list"
}

HTML Content to Analyze:
\`\`\`html
${htmlContent}
\`\`\`

Return ONLY the JSON object. Do not include any explanations or markdown formatting around the JSON.`;
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are an AI assistant specialized in analyzing HTML structure to find CSS selectors for resume sections. You return only valid JSON matching the requested format. You MUST create selectors that do not overlap between different section types."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.2,
                max_tokens: 800,
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
            const selectors = JSON.parse(content);
            const requiredKeys = [
                "jobSectionSelector", "jobBulletSelector",
                "projectSectionSelector", "projectBulletSelector",
                "educationSectionSelector", "educationBulletSelector",
                "skillsSectionSelector"
            ];
            const hasAllKeys = requiredKeys.every(key => typeof selectors[key] === 'string' && selectors[key].length > 0);
            if (typeof selectors === 'object' && selectors !== null && hasAllKeys) {
                console.log('Successfully received and parsed legacy dynamic selectors:', selectors);
                return selectors;
            } else {
                 console.error('LLM returned invalid JSON structure or missing keys:', content);
                 return {};
            }
        } catch (jsonError) {
            console.error('Error parsing JSON from LLM response:', jsonError, 'Raw content:', content);
            const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/{[\s\S]*?}/);
            if (jsonMatch) {
                try {
                    const extractedJsonString = jsonMatch[1] || jsonMatch[0];
                    const selectors = JSON.parse(extractedJsonString);
                    const requiredKeys = [
                        "jobSectionSelector", "jobBulletSelector",
                        "projectSectionSelector", "projectBulletSelector",
                        "educationSectionSelector", "educationBulletSelector",
                        "skillsSectionSelector"
                    ];
                     const hasAllKeys = requiredKeys.every(key => typeof selectors[key] === 'string' && selectors[key].length > 0);
                     if (typeof selectors === 'object' && selectors !== null && hasAllKeys) {
                        console.log('Successfully parsed extracted legacy dynamic selectors:', selectors);
                        return selectors;
                    } else {
                         console.error('LLM returned invalid JSON structure even after extraction:', extractedJsonString);
                         return {};
                    }
                } catch (nestedJsonError) {
                     console.error('Error parsing extracted JSON:', nestedJsonError, 'Extracted string:', jsonMatch[1] || jsonMatch[0]);
                     return {};
                }
            }
            return {};
        }
    } catch (error) {
        console.error('Error calling OpenAI API for legacy dynamic selectors:', error.response?.data || error.message);
        if (error.response?.data?.error) {
            console.error('OpenAI API Error Details:', error.response.data.error);
        }
        return {};
    }
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

module.exports = { customizeResume, getDynamicSelectors };
