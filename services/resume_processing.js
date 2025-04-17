const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for Gemini
const geminiApiKey = process.env.GEMINI_API_KEY;
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
    const basePrompt = `You are a specialized resume bullet point optimizer tasked with crafting high-impact achievement statements. Approach each bullet point with comprehensive analysis using this structured framework:

ANALYSIS FRAMEWORK:
1. Achievement Analysis
   - Identify the core accomplishment
   - Extract quantifiable metrics and their significance
   - Evaluate the impact scope (individual, team, organization)
   - Consider both immediate and long-term outcomes

2. Technical Integration Assessment
   - Review available keywords: ${keywords}
   - Map technologies to their domains:
     * Frontend: UI/UX, client-side frameworks
     * Backend: Server architecture, APIs
     * Database: Data storage, queries
     * DevOps: Deployment, optimization
   - Evaluate technical synergies and conflicts
   - Validate domain-appropriate combinations

3. Impact Articulation Strategy
   - Select metrics that best demonstrate value:
     * Performance improvements (%, time)
     * Scale indicators (users, transactions)
     * Resource optimization (cost, efficiency)
     * Business outcomes (revenue, savings)
   - Ensure metric-achievement alignment
   - Verify metric specificity and credibility

4. Linguistic Optimization Process
   - Action Verb Selection:
     * Performance: Improved, Increased, Reduced, Decreased, Optimized
     * Development: Developed, Designed, Implemented, Created, Launched
     * Leadership: Led, Directed, Coordinated, Managed
     * Analysis: Analyzed, Evaluated, Solved
     * Avoid: Built, Helped, Used, Worked, Orchestrated, Revolutionized
   - Word economy (${wordLimit} words max)
   - Technical terminology precision
   - Achievement clarity

OUTPUT REQUIREMENTS:
1. Format: Each bullet MUST start with '>>' (no space after)
2. Metrics: ONE specific measurement per bullet (%, $, time, quantity)
3. Technology: 1-2 related tools per bullet, domain-appropriate only
4. Structure: Action verb + achievement + metric + context
5. Coverage: Each keyword must appear at least once across all bullets

TECHNOLOGY INTEGRATION EXAMPLES:

Strong Integration (Domain-Aligned):
>>Optimized React component rendering with Redux state management, reducing page load time by 45%
>>Engineered PostgreSQL query optimization pipeline, processing 2M records daily
>>Implemented Redis caching layer for Node.js microservices, cutting API response time by 75%

Weak Integration (Domain-Mismatched):
>>Used React for database optimization (Domain mismatch)
>>Applied CSS Grid to MongoDB queries (Incompatible domains)
>>Implemented Python scripts in React components (Framework conflict)

INPUT TO ENHANCE:
${(existingBullets || []).join('\n')}`;

    const prompt = mode === 'tailor' 
        ? `${basePrompt}\n\nTASK: Apply the analysis framework to enhance these bullets, preserving original metrics while integrating keywords naturally.`
        : `${basePrompt}\n\nTASK: Generate 15 achievement-focused bullets ${context} by following the analysis framework for each bullet point.`;

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${geminiApiKey}`,
            {
                system_instruction: {
                    parts: [{
                        text: "You are a specialized resume bullet point optimizer. Your task is to generate or enhance resume bullets following these STRICT rules:\n1. Every bullet MUST start with '>>' (no space)\n2. Use ONLY related technologies together\n3. Use each provided keyword at least once\n4. Include ONE specific metric per bullet\n5. Use ONLY approved action verbs\n6. Never exceed word limit\n7. Never mix unrelated technologies\n8. Focus on concrete achievements"
                    }]
                },
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.5,
                    maxOutputTokens: 7000
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        const content = response.data.candidates[0].content.parts[0].text;
        
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
            
            bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
        }

        bulletPoints = bulletPoints
            .filter(bp => !bulletTracker.isUsed(bp) || 
                        bulletTracker.canUseBulletInSection(bp, sectionType))
            .slice(0, targetBulletCount);

        bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);

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
            
            const skillsSection = $('.section-content').eq(0);
            if (skillsSection.length === 0) {
                console.warn('Skills section not found in resume');
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
                    const keywords = categorizedKeywords[dataKey].join(', ');
                    const paragraph = skillsSection.find(`p:contains("${htmlLabel}")`);
                    
                    if (paragraph.length > 0) {
                        paragraph.html(`<strong>${htmlLabel}</strong> ${keywords}`);
                    } else {
                        skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywords}</p>`);
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