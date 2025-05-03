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
    const basePrompt = `You are a specialized resume bullet point optimizer focused on creating technically accurate and ATS-friendly content. Your task is to generate or enhance resume bullets that demonstrate technical expertise while maintaining STRICTLY ACCURATE technology relationships.

CRITICAL TECHNOLOGY RELATIONSHIP RULES:
1. NEVER combine technologies from different ecosystems that don't naturally work together
2. Each bullet should focus on 1-2 closely related technologies maximum
3. Always verify technology relationships before combining them
4. If unsure about a technology relationship, use only the primary technology

TECHNOLOGY DOMAIN RULES AND RELATIONSHIPS:
1. Programming Languages & Their Ecosystems:
   - Java → Spring, Hibernate, Maven, JUnit
   - Python → Django, Flask, NumPy, Pandas
   - JavaScript → Node.js, React, Angular, Express
   - TypeScript → Angular, React, Next.js
   - C# → .NET, ASP.NET, Entity Framework
   NEVER MIX: Java with Python libraries, JavaScript with Java frameworks, etc.

2. Frontend Development:
   - React → Redux, React Router, Material-UI
   - Angular → RxJS, NgRx, Angular Material
   - Vue.js → Vuex, Vue Router
   NEVER MIX: React hooks with Angular services, Vue with Redux, etc.

3. Backend & Databases:
   - Node.js → Express, MongoDB, Mongoose
   - Django → PostgreSQL, SQLite
   - Spring → MySQL, Oracle, Hibernate
   NEVER MIX: Django ORM with MongoDB, Hibernate with MongoDB, etc.

4. Cloud & DevOps:
   - AWS → EC2, S3, Lambda, CloudFormation
   - Azure → App Service, Functions, DevOps
   - GCP → Compute Engine, Cloud Functions
   NEVER MIX: AWS services with Azure-specific terms, GCP with AWS-specific services

5. Mobile Development:
   - iOS → Swift, SwiftUI, Cocoa Touch
   - Android → Kotlin, Java, Android SDK
   - React Native → JavaScript, React
   NEVER MIX: Swift with Android SDK, Kotlin with iOS frameworks

6. CRM & Business Systems:
   - Salesforce → Apex, Visualforce, Lightning
   - Microsoft Dynamics → C#, .NET
   NEVER MIX: Apex with Java/Python, Salesforce-specific with general web tech

INVALID COMBINATION EXAMPLES (NEVER GENERATE THESE):
❌ "Developed Apex triggers using Java" (Apex is Salesforce-specific)
❌ "Built React components using Angular services" (Different frameworks)
❌ "Implemented Django models with MongoDB" (Django uses SQL databases)
❌ "Created AWS Lambda functions using Azure Functions" (Different clouds)
❌ "Developed iOS apps using Android SDK" (Different mobile platforms)

FORMATTING RULES:
1. Every bullet MUST start with '>>' (no space after)
2. One specific metric per bullet (%, $, time, or quantity)
3. Each bullet MUST begin with a strong action verb
4. NEVER reuse the same starting verb across bullet points
5. Each bullet MUST be ${wordLimit} words or less

KEYWORD INTEGRATION RULES:
1. Use keywords from this list: ${keywords}
2. Use ONLY 1-2 related technologies per bullet
3. Technologies MUST be from the same domain or have a clear, logical relationship
4. Each keyword MUST be used at least once across all bullets
5. If a technology doesn't fit naturally, preserve the achievement without the tech reference

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
        ? `${basePrompt}\n\nTASK: Enhance the above bullets by naturally and thoroughly integrating ALL provided keywords. Every keyword must appear at least once across the set. Maintain original metrics and achievements. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above.`
        : `${basePrompt}\n\nTASK: Generate 15 achievement-focused bullets ${context} with concrete metrics and varied action verbs, ensuring that ALL provided keywords are integrated at least once across the set. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above.`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume bullet point optimizer with deep understanding of technology relationships. You must NEVER generate bullets with invalid technology combinations. First analyze the keywords to understand their relationships, then generate bullets ensuring technical accuracy."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.4,
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
    
    const resumeContent = await parseResumeContent(htmlContent);
    if (!resumeContent) {
        console.error("Failed to parse resume content. Aborting resume update.");
        return htmlContent;
    }

    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();

    const sections = [
        { type: 'job', entries: resumeContent.jobs, targetBulletCount: 4 },
        { type: 'project', entries: resumeContent.projects, targetBulletCount: 3 }
    ];

    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    for (const section of sections) {
        for (const entry of section.entries) {
            const originalBullets = entry.bulletPoints || [];
            
            const newBullets = await generateBullets(
                fullTailoring ? 'tailor' : 'generate',
                originalBullets,
                keywordString,
                `for ${section.type} experience`,
                12
            );

            await updateBulletPoints($, originalBullets, newBullets);

            newBullets.forEach(bullet => {
                bulletCache.addBulletToSection(bullet, section.type);
                const verb = getFirstVerb(bullet);
                if (verb) verbTracker.addVerb(verb, section.type);
            });
        }
    }

    await updateSkillsContent($, resumeContent.skills);

    let currentBulletCount = 4;
    let attempts = 0;
    const MIN_BULLETS = 2;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;

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

async function updateSkillsContent($, skillsData) {
    const skillElements = $('p, div, section').filter((_, el) => {
        const text = $(el).text().toLowerCase();
        return text.includes('skills') || text.includes('technologies') || text.includes('tools');
    });

    if (skillElements.length === 0) {
        console.warn('No skills section found in the HTML');
        return;
    }

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
            skillsContainer = $(el);
        }
    });

    if (!skillsContainer) {
        console.warn('Could not identify main skills container');
        return;
    }

    skillsContainer.empty();

    const styleElement = $('<style></style>');
    styleElement.text('.skills-section p { margin: 0; padding: 2px 0; }');
    $('head').append(styleElement);

    const categorizedSkills = await categorizeKeywords(
        Object.values(skillsData).flat()
    );

    if (!categorizedSkills) {
        console.warn('Failed to categorize skills');
        return;
    }

    const categories = Object.entries(categorizedSkills);
    categories.forEach(([category, skills], index) => {
        if (skills && skills.length > 0) {
            const formattedCategory = category
                .split(/(?=[A-Z])/)
                .join(' ')
                .replace(/^\w/, c => c.toUpperCase());

            const categoryElement = $('<p></p>');
            categoryElement.html(`<strong>${formattedCategory}:</strong> ${skills.join(', ')}`);
            skillsContainer.append(categoryElement);
        }
    });

    skillsContainer.addClass('skills-section');
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
    const bulletMap = new Map();
    $('li').each((_, el) => {
        const text = $(el).text().trim();
        if (text && originalBullets.includes(text)) {
            bulletMap.set(text, el);
        }
    });

    originalBullets.forEach((originalText, index) => {
        if (index < newBullets.length && bulletMap.has(originalText)) {
            const element = bulletMap.get(originalText);
            $(element).text(newBullets[index]);
        }
    });
}

module.exports = { customizeResume };
