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

async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    
    // Parse the resume content using LLM
    const resumeContent = await parseResumeContent(htmlContent);
    if (!resumeContent) {
        console.error("Failed to parse resume content. Aborting resume update.");
        return htmlContent;
    }

    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();

    // Process each section
    const sections = [
        { type: 'job', entries: resumeContent.jobs, targetBulletCount: 4 },
        { type: 'project', entries: resumeContent.projects, targetBulletCount: 3 }
    ];

    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate and update bullets for each section
    for (const section of sections) {
        for (const entry of section.entries) {
            const originalBullets = entry.bulletPoints || [];
            
            // Generate new bullets
            const newBullets = await generateBullets(
                fullTailoring ? 'tailor' : 'generate',
                originalBullets,
                keywordString,
                `for ${section.type} experience`,
                12
            );

            // Update the bullets in the HTML
            await updateBulletPoints($, originalBullets, newBullets);

            // Cache the generated bullets
            newBullets.forEach(bullet => {
                bulletCache.addBulletToSection(bullet, section.type);
                const verb = getFirstVerb(bullet);
                if (verb) verbTracker.addVerb(verb, section.type);
            });
        }
    }

    // Update skills section
    await updateSkillsContent($, resumeContent.skills);

    // Check page length and adjust if necessary
    let currentBulletCount = 4; // Start with maximum
    let attempts = 0;
    const MIN_BULLETS = 2;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;

        // Reduce bullet count and regenerate
        currentBulletCount--;
        for (const section of sections) {
            for (const entry of section.entries) {
                const originalBullets = entry.bulletPoints || [];
                const cachedBullets = bulletCache.getBulletsForSection(section.type, currentBulletCount);
                await updateBulletPoints($, originalBullets, cachedBullets);
            }
        }
        attempts++;
    }

    return $.html();
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
    
    try {
        const page = await browser.newPage();
        
        // Set viewport to a standard screen width to prevent scaling issues
        await page.setViewport({
            width: 1024,  // Standard screen width
            height: 1320, // Larger than letter size to accommodate content
            deviceScaleFactor: 1
        });

        // Configure resource loading
        await page.setRequestInterception(true);
        const resourceCache = new Map();
        
        page.on('request', async request => {
            const url = request.url();
            if (resourceCache.has(url)) {
                await request.respond({
                    body: resourceCache.get(url)
                });
                return;
            }
            request.continue();
        });

        page.on('response', async response => {
            const url = response.url();
            if (response.ok() && !resourceCache.has(url)) {
                try {
                    const buffer = await response.buffer();
                    resourceCache.set(url, buffer);
                } catch (e) {
                    console.warn(`Failed to cache resource ${url}:`, e.message);
                }
            }
        });

        // Enhanced print styles with font size controls
        const printStyles = `
            @page {
                size: Letter;
                margin: 0.25in;
            }
            @media print {
                html {
                    /* Set base font size to control scaling */
                    font-size: 12px !important;
                }
                body {
                    /* Preserve original proportions */
                    width: 8.5in;
                    min-height: 11in;
                    margin: 0;
                    padding: 0;
                    /* Prevent text inflation */
                    -webkit-text-size-adjust: 100%;
                    text-size-adjust: 100%;
                }
                /* Ensure background colors and images are printed */
                * {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
            }
        `;

        // Set content and wait for resources to load
        await page.setContent(htmlContent, {
            waitUntil: ['networkidle0', 'load', 'domcontentloaded']
        });

        // Inject print styles and handle fonts
        await page.evaluate((styles) => {
            // Add print styles
            const styleElement = document.createElement('style');
            styleElement.textContent = styles;
            document.head.appendChild(styleElement);

            // Force load custom fonts
            const fontPromises = Array.from(document.fonts).map(font => font.load());
            return Promise.all(fontPromises);
        }, printStyles);

        // Ensure screen styles are used for PDF generation
        await page.emulateMediaType('screen');

        // Calculate actual content height
        const height = await page.evaluate(() => {
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

        const MAX_HEIGHT = 1056; // 11 inches * 96 DPI

        // Generate PDF with optimized settings for proper scaling
        const pdfBuffer = await page.pdf({
            format: 'Letter',
            printBackground: true,
            preferCSSPageSize: true,
            margin: {
                top: '0.25in',
                right: '0.25in',
                bottom: '0.25in',
                left: '0.25in'
            },
            displayHeaderFooter: false,
            scale: 0.85, // Slightly reduce scale to prevent overflow
        });

        return { 
            pdfBuffer, 
            exceedsOnePage: height > MAX_HEIGHT 
        };
    } catch (error) {
        console.error('PDF conversion error:', error);
        throw error;
    } finally {
        await browser.close();
    }
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

async function updateSkillsContent($, skillsData) {
    // Find all elements that might contain skills
    const skillElements = $('p, div').filter((_, el) => {
        const text = $(el).text().toLowerCase();
        return text.includes('skills') || text.includes('technologies') || text.includes('tools');
    });

    if (skillElements.length === 0) {
        console.warn('No skills section found in the HTML');
        return;
    }

    // Find the most likely skills container (the one with the most skill-related content)
    let skillsContainer = null;
    let maxSkillCount = 0;

    skillElements.each((_, el) => {
        const text = $(el).text().toLowerCase();
        const skillCount = Object.values(skillsData)
            .flat()
            .filter(skill => text.includes(skill.toLowerCase()))
            .length;
        
        if (skillCount > maxSkillCount) {
            maxSkillCount = skillCount;
            skillsContainer = el;
        }
    });

    if (!skillsContainer) {
        console.warn('Could not identify main skills container');
        return;
    }

    // Create new skills content
    let skillsContent = '';
    for (const [category, skills] of Object.entries(skillsData)) {
        if (skills.length > 0) {
            const categoryTitle = category.charAt(0).toUpperCase() + category.slice(1);
            skillsContent += `<p><strong>${categoryTitle}:</strong> ${skills.join(', ')}</p>`;
        }
    }

    // Replace the content of the skills container
    $(skillsContainer).html(skillsContent);
}

async function parseResumeContent(htmlContent) {
    const cacheKey = `resumeContent_${generateHash(htmlContent)}`;
    if (lmCache.has(cacheKey)) {
        console.log('Returning cached resume content structure.');
        return lmCache.get(cacheKey);
    }

    console.log('Parsing resume content structure using LLM...');
    const prompt = `Analyze the following HTML resume content and extract its semantic structure. Focus on identifying and extracting the actual content of each section, regardless of HTML structure or CSS classes used.

Return ONLY a valid JSON object with the following structure:
{
    "jobs": [{
        "title": "Job Title",
        "company": "Company Name",
        "dates": "Date Range",
        "location": "Location",
        "bulletPoints": ["Original bullet point 1", "Original bullet point 2", ...]
    }],
    "projects": [{
        "title": "Project Name",
        "technologies": "Technologies Used (if specified)",
        "dates": "Date Range (if specified)",
        "bulletPoints": ["Original bullet point 1", "Original bullet point 2", ...]
    }],
    "education": [{
        "degree": "Degree Name",
        "institution": "Institution Name",
        "dates": "Date Range",
        "location": "Location",
        "bulletPoints": ["Original bullet point or achievement 1", ...]
    }],
    "skills": {
        "technical": ["Skill 1", "Skill 2", ...],
        "tools": ["Tool 1", "Tool 2", ...],
        "other": ["Other skill 1", ...]
    }
}

IMPORTANT GUIDELINES:
1. Extract ONLY text that actually exists in the HTML. Do not generate or infer content.
2. Include ALL bullet points found in each section, preserving their exact text.
3. For each section (jobs, projects, education), ensure bullet points are correctly associated with their parent entry.
4. For skills, categorize them if categories are present in the original, otherwise put all in "technical".
5. Preserve exact text formatting, including case and punctuation.
6. If a field is not found (e.g., no location for a job), omit that field rather than returning empty string.

HTML Content to Analyze:
\`\`\`html
${htmlContent}
\`\`\`

Return ONLY the JSON object. Do not include any explanations or markdown formatting.`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are an AI assistant specialized in parsing resume content. You extract the semantic structure and content from HTML resumes, preserving the exact text while organizing it into a clear JSON structure. You return only valid JSON matching the requested format."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.2,
                max_tokens: 2000,
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
            const parsedContent = JSON.parse(content);
            
            // Validate the structure
            const requiredSections = ['jobs', 'projects', 'education', 'skills'];
            const hasAllSections = requiredSections.every(section => 
                Array.isArray(parsedContent[section]) || 
                (section === 'skills' && typeof parsedContent[section] === 'object')
            );

            if (typeof parsedContent === 'object' && parsedContent !== null && hasAllSections) {
                console.log('Successfully parsed resume content structure');
                lmCache.set(cacheKey, parsedContent);
                return parsedContent;
            } else {
                console.error('LLM returned invalid JSON structure:', content);
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

async function updateBulletPoints($, originalBullets, newBullets) {
    // Create a map of original bullet text to its HTML element
    const bulletMap = new Map();
    $('li').each((_, el) => {
        const text = $(el).text().trim();
        if (text && originalBullets.includes(text)) {
            bulletMap.set(text, el);
        }
    });

    // Replace each original bullet with its corresponding new bullet
    originalBullets.forEach((originalText, index) => {
        if (index < newBullets.length && bulletMap.has(originalText)) {
            const element = bulletMap.get(originalText);
            $(element).text(newBullets[index]);
        }
    });
}

module.exports = { customizeResume };
