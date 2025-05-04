const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util');

const openaiApiKey = process.env.OPENAI_API_KEY;

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
    // Ensure existingBullets is never null to avoid issues
    existingBullets = existingBullets || [];
    
    // Remove any duplicates from existing bullets before processing
    const uniqueExistingBullets = [...new Set(existingBullets)];
    
    const basePrompt = `You are a specialized resume bullet point optimizer focused on creating technically accurate and ATS-friendly content. Your task is to generate or enhance resume bullets that demonstrate technical expertise while maintaining STRICTLY ACCURATE technology relationships. Your responses will be used to improve a resume programmatically. CRITICAL: Each bullet point must be ENTIRELY UNIQUE from others - no duplicates or near-duplicates.

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
        ? `${basePrompt}\n\nTASK: Enhance the above bullets by naturally and thoroughly integrating ALL provided keywords. Every keyword must appear at least once across the set. Maintain original metrics and achievements. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above. Each bullet MUST be completely unique - no repetition of the same or similar bullet points.`
        : `${basePrompt}\n\nTASK: Generate 15 achievement-focused bullets ${context} with concrete metrics and varied action verbs, ensuring that ALL provided keywords are integrated at least once across the set. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above AND every bullet is 100% unique - no duplicated content or concepts.`;

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
        const deduplicationMap = new Map(); // Track similar bullets by first 5 words
        
        const bullets = lines
            .map(line => line.trim())
            .filter(line => line.startsWith('>>'))
            .map(bullet => 
                bullet.replace(/^>>\s*/, '')
                      .replace(/\*\*/g, '')
                      .replace(/\s*\([^)]*\)$/, '')
            )
            .filter(bullet => {
                // First check exact matches
                const norm = bullet.toLowerCase().replace(/\s+/g, ' ').trim();
                if (seenBullets.has(norm)) return false;
                seenBullets.add(norm);
                
                // Then check for similar bullets (same starting words)
                const firstWords = norm.split(' ').slice(0, 5).join(' ');
                if (deduplicationMap.has(firstWords)) {
                    // If we already have a bullet starting with these words, reject this one
                    return false;
                }
                deduplicationMap.set(firstWords, bullet);
                return true;
            });
        return bullets;
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}

function shuffleArray(array) {
    // Create a copy to avoid modifying original array
    const result = [...array];
    let currentIndex = result.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [result[currentIndex], result[randomIndex]] = [result[randomIndex], result[currentIndex]];
    }
    return result;
}

function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 15;
    // Important: Create a copy of the bullets array to avoid modifying the original
    let workingBullets = [...bullets];
    
    while (attempts < maxAttempts) {
        // Use shuffleArray but don't reassign the input parameter
        const shuffled = shuffleArray(workingBullets);
        let isValid = true;
        let previousVerbs = new Set();
        
        for (let i = 0; i < shuffled.length; i++) {
            const currentVerb = getFirstVerb(shuffled[i]);
            if (!currentVerb) continue;
            if (previousVerbs.has(currentVerb) || 
                (verbTracker.isVerbUsedGlobally(currentVerb) && i === 0)) {
                isValid = false;
                break;
            }
            previousVerbs.add(currentVerb);
        }
        
        if (isValid) {
            if (shuffled.length > 0) {
                verbTracker.addVerb(getFirstVerb(shuffled[0]), sectionType);
            }
            return shuffled;
        }
        attempts++;
    }
    
    const sortedBullets = [...workingBullets].sort((a, b) => {
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

            await updateBulletPoints($, originalBullets, newBullets, entry.selector);

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
                await updateBulletPoints($, originalBullets, cachedBullets, entry.selector);
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
            return JSON.parse(jsonString);
        } catch (jsonError) {
            console.error('Error parsing JSON from LLM response:', jsonError);
            const fallbackCategories = {
                "Languages": [],
                "Frameworks/Libraries": [],
                "Others": []
            };
            fallbackCategories["Others"] = keywords;
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
    console.log('Parsing resume content structure using LLM...');
    const prompt = `Analyze the following HTML resume content and extract its semantic structure. Focus on identifying and extracting the actual content of each section, regardless of HTML structure or CSS classes used.

Return ONLY a valid JSON object with the following structure:
{
    "jobs": [{
        "title": "Job Title",
        "company": "Company Name",
        "dates": "Date Range",
        "location": "Location",
        "bulletPoints": ["Original bullet point 1", "Original bullet point 2", ...],
        "selector": "EXACT CSS SELECTOR TO LOCATE THIS SPECIFIC JOB ENTRY IN THE HTML"
    }],
    "projects": [{
        "title": "Project Name",
        "technologies": "Technologies Used (if specified)",
        "dates": "Date Range (if specified)",
        "bulletPoints": ["Original bullet point 1", "Original bullet point 2", ...],
        "selector": "EXACT CSS SELECTOR TO LOCATE THIS SPECIFIC PROJECT ENTRY IN THE HTML"
    }],
    "education": [{
        "degree": "Degree Name",
        "institution": "Institution Name",
        "dates": "Date Range",
        "location": "Location",
        "bulletPoints": ["Original bullet point or achievement 1", ...],
        "selector": "EXACT CSS SELECTOR TO LOCATE THIS SPECIFIC EDUCATION ENTRY IN THE HTML"
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

ABSOLUTELY CRITICAL SELECTOR REQUIREMENTS:
1. For each job, project, and education entry, you MUST provide a CSS selector that is GUARANTEED to uniquely identify that specific element in the DOM.
2. Your selector MUST include text content from the entry to ensure uniqueness - this is the ONLY reliable way to target specific entries.
3. NEVER use nth-of-type or positional selectors (like :first-child, :nth-child) as the PRIMARY selection mechanism.
4. ALWAYS use :contains() with company names, job titles, project names, or other unique text content.
5. Focus on using clear, text-based identifiers that will NEVER change even if the order of elements changes.

SELECTOR EXAMPLES (REQUIRED APPROACH):
- BAD: ".section .entry:nth-of-type(1)" - This will break if order changes
- BAD: "div.job:nth-child(2)" - This is too brittle and position-dependent
- GOOD: ".professional-experience h3:contains('Callagy Law')" - Uses text content as identifier
- GOOD: "h3:contains('Secure Test Portal')" - Uses project name to find the section
- GOOD: "div:contains('Full Stack Developer'):contains('Callagy Law')" - Combines role and company
- GOOD: "div:has(h3:contains('Willounden'))" - Targets container with specific heading

RESUME-SPECIFIC SELECTOR STRATEGIES:
1. For jobs: Use company name in selector like "div:contains('Google')" or "h3:contains('Google')"
2. For projects: Use project name like "div:contains('Secure Test Portal')" 
3. For education: Use institution name like "div:contains('New Jersey Institute')"
4. Always target the CONTAINER element that holds all information about that entry
5. Use multiple :contains() if needed for unique identification

HTML Content to Analyze:
\`\`\`html
${htmlContent}
\`\`\`

Return ONLY the JSON object with these text-based reliable selectors. Your selectors MUST use text content to identify elements.`;

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
        
        // First, analyze the HTML to find all bullet points
        const $ = cheerio.load(htmlContent);
        const allBullets = $('li').map((_, el) => $(el).text().trim()).get();
        console.log(`Found ${allBullets.length} total bullet points in original resume`);
        
        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        // Check how many bullets were updated by comparing before and after
        const $updated = cheerio.load(updatedHtmlContent);
        const updatedBullets = $updated('li').map((_, el) => $(el).text().trim()).get();
        
        // Count how many bullets changed
        let changedCount = 0;
        for (let i = 0; i < Math.min(allBullets.length, updatedBullets.length); i++) {
            if (allBullets[i] !== updatedBullets[i]) {
                changedCount++;
            }
        }
        console.log(`Changed ${changedCount} bullet points out of ${allBullets.length}`);
        
        // Count bullet points by section for logging
        const jobBullets = $updated('li').filter((_, el) => {
            return $updated(el).closest('div').text().toLowerCase().includes('experience') ||
                   $updated(el).closest('div').text().includes('Callagy') ||
                   $updated(el).closest('div').text().includes('Willouden');
        }).length;
        
        const projectBullets = $updated('li').filter((_, el) => {
            return $updated(el).closest('div').text().toLowerCase().includes('project') ||
                   $updated(el).closest('div').text().includes('Portal') ||
                   $updated(el).closest('div').text().includes('Recipe');
        }).length;
        
        const educationBullets = $updated('li').filter((_, el) => {
            return $updated(el).closest('div').text().toLowerCase().includes('education') ||
                   $updated(el).closest('div').text().includes('Jersey');
        }).length;
        
        console.log(`Generated bullet counts: Jobs=${jobBullets}, Projects=${projectBullets}, Education=${educationBullets}`);
        
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);
        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));
    } catch (error) {
        console.error('Detailed error:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

async function updateBulletPoints($, originalBullets, newBullets, selector) {
    // First, try using the selector if provided
    if (selector) {
        try {
            // If selector uses :contains, make sure it's properly quoted for Cheerio
            let processedSelector = selector;
            if (selector.includes(':contains(')) {
                // Handle quoted contains in a basic way
                processedSelector = selector.replace(/:contains\('([^']*)'\)/g, `:contains("$1")`);
                processedSelector = processedSelector.replace(/:contains\(([^"'()]*)\)/g, `:contains("$1")`);
            }
            
            console.log(`Trying to find elements using selector: ${processedSelector}`);
            const entryElement = $(processedSelector);
            
            if (entryElement.length > 0) {
                console.log(`Found matching element for selector: ${processedSelector}`);
                
                // Try multiple approaches to find bullet points
                
                // 1. Look for ul/ol elements with li children
                const ulElements = entryElement.find('ul, ol');
                if (ulElements.length > 0) {
                    console.log(`Found ${ulElements.length} list containers`);
                    
                    // Try each list container until we successfully update one
                    for (let i = 0; i < ulElements.length; i++) {
                        const bulletList = $(ulElements[i]);
                        const existingBullets = bulletList.find('li');
                        
                        // If we have existing bullets, update them
                        if (existingBullets.length > 0) {
                            console.log(`Found ${existingBullets.length} bullet points in container ${i+1}`);
                            
                            // Check if any bullet text matches original bullets to confirm we have the right list
                            let foundMatch = false;
                            existingBullets.each((_, el) => {
                                const elText = $(el).text().trim();
                                if (originalBullets.includes(elText)) {
                                    foundMatch = true;
                                }
                            });
                            
                            if (foundMatch || existingBullets.length >= originalBullets.length) {
                                // Update bullets one by one
                                let updatedCount = 0;
                                existingBullets.each((idx, el) => {
                                    if (idx < newBullets.length) {
                                        // Try to preserve any inner HTML structures
                                        const $el = $(el);
                                        if ($el.children().length > 0) {
                                            $el.contents().filter((_, node) => node.nodeType === 3).remove();
                                            $el.prepend(newBullets[idx]);
                                        } else {
                                            $el.html(newBullets[idx]);
                                        }
                                        updatedCount++;
                                    }
                                });
                                
                                console.log(`Updated ${updatedCount} bullet points`);
                                return true;
                            } else {
                                console.log(`Skipping container ${i+1} - no matching bullets found`);
                            }
                        } else {
                            // If no bullets, create new ones in this container
                            bulletList.empty();
                            newBullets.forEach(bullet => {
                                bulletList.append(`<li>${bullet}</li>`);
                            });
                            console.log(`Created ${newBullets.length} new bullet points`);
                            return true;
                        }
                    }
                }
                
                // 2. Look for bullet points with specific classes or formatting
                const bulletElements = entryElement.find('li, .bullet, [class*="bullet"]');
                if (bulletElements.length > 0) {
                    console.log(`Found ${bulletElements.length} bullet elements directly`);
                    
                    // Check if any bullet text matches original bullets to confirm we have the right elements
                    let foundMatch = false;
                    bulletElements.each((_, el) => {
                        const elText = $(el).text().trim();
                        if (originalBullets.includes(elText)) {
                            foundMatch = true;
                        }
                    });
                    
                    if (foundMatch || bulletElements.length >= originalBullets.length) {
                        let updatedCount = 0;
                        bulletElements.each((idx, el) => {
                            if (idx < newBullets.length) {
                                // Try to preserve any inner HTML structures
                                const $el = $(el);
                                if ($el.children().length > 0) {
                                    $el.contents().filter((_, node) => node.nodeType === 3).remove();
                                    $el.prepend(newBullets[idx]);
                                } else {
                                    $el.html(newBullets[idx]);
                                }
                                updatedCount++;
                            }
                        });
                        console.log(`Updated ${updatedCount} bullet points directly`);
                        return true;
                    }
                }
                
                // 3. Look specifically for list items that contain the original bullet text
                let matchFound = false;
                let matchedCount = 0;
                
                // Create a map to track which bullets we've updated to avoid duplication
                const updatedBullets = new Map();
                
                for (const originalBullet of originalBullets) {
                    try {
                        // Make sure we properly escape special characters for use in selectors
                        const escapedBullet = originalBullet
                            .replace(/"/g, '\\"')
                            .replace(/'/g, "\\'")
                            .replace(/\[/g, "\\[")
                            .replace(/\]/g, "\\]");
                        
                        // First try exact text match
                        const exactMatches = entryElement.find('li').filter(function() {
                            return $(this).text().trim() === originalBullet;
                        });
                        
                        if (exactMatches.length > 0) {
                            matchFound = true;
                            // Find the index of this bullet in the original list
                            const bulletIndex = originalBullets.indexOf(originalBullet);
                            if (bulletIndex >= 0 && bulletIndex < newBullets.length && !updatedBullets.has(bulletIndex)) {
                                // Update the bullet text, preserving any HTML structure
                                const $el = $(exactMatches[0]);
                                if ($el.children().length > 0) {
                                    $el.contents().filter((_, node) => node.nodeType === 3).remove();
                                    $el.prepend(newBullets[bulletIndex]);
                                } else {
                                    $el.html(newBullets[bulletIndex]);
                                }
                                matchedCount++;
                                updatedBullets.set(bulletIndex, true);
                            }
                        } else {
                            // If exact match fails, try contains
                            const matchedBullets = entryElement.find(`li:contains("${escapedBullet}")`);
                            if (matchedBullets.length > 0) {
                                matchFound = true;
                                matchedBullets.each((_, el) => {
                                    const $el = $(el);
                                    const bulletText = $el.text().trim();
                                    // Find the closest matching bullet in the original list
                                    let bestMatch = -1;
                                    let bestMatchScore = 0;
                                    
                                    for (let i = 0; i < originalBullets.length; i++) {
                                        if (bulletText.includes(originalBullets[i]) && 
                                            originalBullets[i].length > bestMatchScore && 
                                            !updatedBullets.has(i)) {
                                            bestMatch = i;
                                            bestMatchScore = originalBullets[i].length;
                                        }
                                    }
                                    
                                    if (bestMatch >= 0 && bestMatch < newBullets.length) {
                                        if ($el.children().length > 0) {
                                            $el.contents().filter((_, node) => node.nodeType === 3).remove();
                                            $el.prepend(newBullets[bestMatch]);
                                        } else {
                                            $el.html(newBullets[bestMatch]);
                                        }
                                        matchedCount++;
                                        updatedBullets.set(bestMatch, true);
                                    }
                                });
                            }
                        }
                    } catch (error) {
                        console.error(`Error matching bullet '${originalBullet.substring(0, 20)}...': ${error.message}`);
                    }
                }
                
                if (matchFound) {
                    console.log(`Updated ${matchedCount} bullets by text content matching`);
                    return true;
                }
                
                // 4. Last resort: create a new ul if we found the container but no bullets
                if (!entryElement.find('ul').length) {
                    console.log(`Creating new bullet list for entry`);
                    const newList = $('<ul></ul>');
                    newBullets.forEach(bullet => {
                        newList.append(`<li>${bullet}</li>`);
                    });
                    
                    // Look for a good spot to insert the list - after headings/title elements
                    const insertAfter = entryElement.find('h1, h2, h3, h4, h5, h6, p:first').last();
                    if (insertAfter.length) {
                        insertAfter.after(newList);
                        return true;
                    } else {
                        entryElement.append(newList);
                        return true;
                    }
                }
            } else {
                console.log(`LLM selector did not match any elements: ${processedSelector}`);
            }
        } catch (error) {
            console.error(`Error using selector: ${error.message}`);
        }
    }
    
    // Fallback to content-based approach
    console.log(`Falling back to content-based bullet matching`);
    let foundSomeMatches = false;
    
    // Try finding unique parent containers for the original bullet points
    const bulletContainers = new Map();
    $('li').each((_, el) => {
        const text = $(el).text().trim();
        if (text && originalBullets.includes(text)) {
            const parent = $(el).parent();
            if (!bulletContainers.has(parent)) {
                bulletContainers.set(parent, []);
            }
            bulletContainers.get(parent).push(el);
            foundSomeMatches = true;
        }
    });
    
    // Update bullets within each container we found
    for (const [container, bullets] of bulletContainers.entries()) {
        for (let i = 0; i < bullets.length; i++) {
            const bulletEl = $(bullets[i]);
            const originalText = bulletEl.text().trim();
            const originalIndex = originalBullets.indexOf(originalText);
            
            if (originalIndex >= 0 && originalIndex < newBullets.length) {
                bulletEl.text(newBullets[originalIndex]);
            }
        }
    }
    
    if (!foundSomeMatches && originalBullets.length > 0) {
        console.log(`Could not find any matching bullet elements for this section`);
        return false;
    }
    
    return foundSomeMatches;
}

module.exports = { customizeResume };
