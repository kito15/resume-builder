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

async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    
    const resumeContent = await parseResumeContent(htmlContent);
    if (!resumeContent) {
        console.error("Failed to parse resume content. Aborting resume update.");
        return htmlContent;
    }

    const verbTracker = new ActionVerbTracker();

    const sections = [
        { type: 'job', entries: resumeContent.jobs, targetBulletCount: 4 },
        { type: 'project', entries: resumeContent.projects, targetBulletCount: 3 }
    ];

    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    console.log('Processing sections with keywords:', keywordString);
    
    let totalSectionUpdates = 0;

    for (const section of sections) {
        console.log(`Processing ${section.type} section`);
        const sectionEntries = section.entries || [];
        
        for (let i = 0; i < sectionEntries.length; i++) {
            const entry = sectionEntries[i];
            const entryName = entry.company || entry.title || `Entry ${i+1}`;
            console.log(`Generating bullets for ${section.type} entry: ${entryName}`);
            
            const originalBullets = entry.bulletPoints || [];
            
            const newBullets = await generateBullets(
                fullTailoring ? 'tailor' : 'generate',
                originalBullets,
                keywordString,
                `for ${section.type} experience`,
                12
            );

            console.log(`Generated ${newBullets.length} new bullets`);

            // First try with the entry's specific selector
            let updated = false;
            if (entry.selector) {
                const entryElement = $(entry.selector);
                if (entryElement.length > 0) {
                    console.log(`Found matching section element for ${section.type} using selector: ${entry.selector}`);
                    
                    // Try to find bullet list within this entry
                    let bulletList = entryElement.find('ul');
                    
                    // If no direct ul found, try to find it in child elements
                    if (bulletList.length === 0) {
                        // Look for any bullets or list items even if not in a ul
                        bulletList = entryElement.find('li').parent();
                    }
                    
                    // If still not found but we have a ul elsewhere that might match
                    if (bulletList.length === 0) {
                        // Find a parent that might contain the bullet list
                        const parent = entryElement.parent();
                        bulletList = parent.find('ul');
                    }
                    
                    if (bulletList.length > 0) {
                        let bulletItems = bulletList.find('li');
                        
                        // Update existing bullets
                        bulletItems.each((idx, item) => {
                            if (idx < newBullets.length) {
                                $(item).text(newBullets[idx]);
                            }
                        });
                        
                        // Add new bullets if needed
                        if (bulletItems.length < newBullets.length) {
                            for (let j = bulletItems.length; j < newBullets.length; j++) {
                                const newItem = $('<li></li>').text(newBullets[j]);
                                bulletList.append(newItem);
                            }
                        }
                        
                        console.log(`Successfully updated bullets for ${section.type}`);
                        totalSectionUpdates++;
                        updated = true;
                    } else {
                        // Try to create a new bullet list
                        console.log(`No bullet list found for ${section.type} entry, attempting to create one`);
                        const newList = $('<ul></ul>');
                        newBullets.forEach(bullet => {
                            newList.append($('<li></li>').text(bullet));
                        });
                        entryElement.append(newList);
                        console.log(`Created new bullet list for ${section.type} entry`);
                        totalSectionUpdates++;
                        updated = true;
                    }
                } else {
                    console.log(`Could not find matching section element for ${section.type} using selector: ${entry.selector}`);
                }
            }
            
            // If we couldn't update using the entry's selector, try the section selector
            if (!updated && resumeContent.selectors) {
                const sectionSelector = resumeContent.selectors[`${section.type}Section`];
                if (sectionSelector) {
                    console.log(`Trying section-wide selector: ${sectionSelector}`);
                    const sectionElement = $(sectionSelector);
                    if (sectionElement.length > 0) {
                        console.log(`Found section container using selector: ${sectionSelector}`);
                        
                        // Find all bullet lists in this section
                        const bulletLists = sectionElement.find('ul');
                        
                        // Try to find a matching bullet list based on the entry's details
                        let matchingList = null;
                        let listIndex = null;
                        
                        // Try to match by company/title text first
                        bulletLists.each((idx, list) => {
                            const $list = $(list);
                            const listParent = $list.parent();
                            const listText = listParent.text().toLowerCase();
                            
                            if (entry.company && listText.includes(entry.company.toLowerCase()) ||
                                entry.title && listText.includes(entry.title.toLowerCase())) {
                                matchingList = $list;
                                listIndex = idx;
                                return false; // Break the loop
                            }
                        });
                        
                        // If we couldn't match by text, take the i-th list
                        if (!matchingList && i < bulletLists.length) {
                            matchingList = $(bulletLists[i]);
                            listIndex = i;
                        }
                        
                        if (matchingList) {
                            console.log(`Found matching bullet list at index ${listIndex}`);
                            let bulletItems = matchingList.find('li');
                            
                            // Update existing bullets
                            bulletItems.each((idx, item) => {
                                if (idx < newBullets.length) {
                                    $(item).text(newBullets[idx]);
                                }
                            });
                            
                            // Add new bullets if needed
                            if (bulletItems.length < newBullets.length) {
                                for (let j = bulletItems.length; j < newBullets.length; j++) {
                                    const newItem = $('<li></li>').text(newBullets[j]);
                                    matchingList.append(newItem);
                                }
                            }
                            
                            console.log(`Updated bullets for ${section.type} using section-wide selector`);
                            totalSectionUpdates++;
                            updated = true;
                        } else {
                            console.log(`Could not find matching bullet list for entry index ${i} in section`);
                        }
                    } else {
                        console.log(`Could not find section container using selector: ${sectionSelector}`);
                    }
                }
            }
            
            // If still not updated, try fallback selectors
            if (!updated) {
                console.log(`Trying fallback selectors for ${section.type} entry`);
                const fallbackSelectors = section.type === 'job' 
                    ? ['.work-experience', '.experience', '.employment', '.jobs', '.work-history', '.professional-experience', 
                       'section:contains("Experience")', 'div:contains("Work Experience")', 'div:contains("Employment")']
                    : ['.projects', '.portfolio', '.project-section', 
                       'section:contains("Project")', 'div:contains("Project")', 'div:contains("Portfolio")'];
                
                let foundElement = null;
                let foundSelector = null;
                
                for (const fallbackSelector of fallbackSelectors) {
                    const elements = $(fallbackSelector);
                    if (elements.length > 0) {
                        foundElement = elements;
                        foundSelector = fallbackSelector;
                        break;
                    }
                }
                
                if (foundElement) {
                    console.log(`Found fallback selector ${foundSelector} for ${section.type}`);
                    
                    // Try to find a bullet list within this element that might correspond to the current entry
                    const bulletLists = foundElement.find('ul');
                    let matchingList = null;
                    
                    // First try to match by content (company/title)
                    bulletLists.each((_, list) => {
                        const $list = $(list);
                        const listParent = $list.parent();
                        const listText = listParent.text().toLowerCase();
                        
                        if (entry.company && listText.includes(entry.company.toLowerCase()) ||
                            entry.title && listText.includes(entry.title.toLowerCase())) {
                            matchingList = $list;
                            return false; // Break the loop
                        }
                    });
                    
                    // If no match by content, try the i-th list
                    if (!matchingList && i < bulletLists.length) {
                        matchingList = $(bulletLists[i]);
                    }
                    
                    if (matchingList) {
                        let bulletItems = matchingList.find('li');
                        
                        // Update existing bullets
                        bulletItems.each((idx, item) => {
                            if (idx < newBullets.length) {
                                $(item).text(newBullets[idx]);
                            }
                        });
                        
                        // Add new bullets if needed
                        if (bulletItems.length < newBullets.length) {
                            for (let j = bulletItems.length; j < newBullets.length; j++) {
                                const newItem = $('<li></li>').text(newBullets[j]);
                                matchingList.append(newItem);
                            }
                        }
                        
                        console.log(`Updated bullets for ${section.type} using fallback selector`);
                        totalSectionUpdates++;
                        updated = true;
                    } else {
                        console.log(`Could not find matching bullet list for entry in fallback section`);
                    }
                } else {
                    console.log(`Could not find any fallback selector matches for ${section.type}`);
                }
            }
            
            if (!updated) {
                console.log(`Could not find matching section element for ${section.type}`);
            }

            newBullets.forEach(bullet => {
                const verb = getFirstVerb(bullet);
                if (verb) verbTracker.addVerb(verb, section.type);
            });
        }
    }

    console.log(`Total section updates completed: ${totalSectionUpdates}`);

    // Verify final bullet counts for debugging
    const jobBullets = $('.work-experience li, .experience li, .employment li, .jobs li, .job-experience li, .professional-experience li, section:contains("Experience") li, div:contains("Work Experience") li, div:contains("Employment") li').length;
    const projectBullets = $('.projects li, .portfolio li, .project-section li, section:contains("Project") li, div:contains("Project") li, div:contains("Portfolio") li').length;
    console.log(`Final verified bullet counts - Jobs: ${jobBullets}, Projects: ${projectBullets}`);

    await updateSkillsContent($, resumeContent.skills);

    let currentBulletCount = 4;
    let attempts = 0;
    const MIN_BULLETS = 2;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;

        currentBulletCount--;
        console.log(`Reducing bullets to ${currentBulletCount} due to page overflow`);
        
        for (const section of sections) {
            if (section.type === 'job') {
                $('.work-experience li, .experience li, .employment li, .jobs li, .job-experience li, .professional-experience li, section:contains("Experience") li, div:contains("Work Experience") li, div:contains("Employment") li').each((i, bullet) => {
                    if (i >= currentBulletCount * resumeContent.jobs.length) {
                        $(bullet).remove();
                    }
                });
            } else {
                $('.projects li, .portfolio li, .project-section li, section:contains("Project") li, div:contains("Project") li, div:contains("Portfolio") li').each((i, bullet) => {
                    if (i >= currentBulletCount * resumeContent.projects.length) {
                        $(bullet).remove();
                    }
                });
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
    const prompt = `Analyze the following HTML resume content and extract its semantic structure AND SELECTORS. Focus on identifying the actual content of each section and the selectors needed to update them, regardless of HTML structure or CSS classes used.

CRITICAL: Pay special attention to job/work experience sections as they often have varied structures in resumes. You MUST provide accurate selectors that can locate each individual job entry and its bullet points.

Return ONLY a valid JSON object with the following structure:
{
    "jobs": [{
        "title": "Job Title",
        "company": "Company Name", 
        "dates": "Date Range",
        "location": "Location",
        "bulletPoints": ["Original bullet point 1", "Original bullet point 2", ...],
        "selector": "CSS selector to uniquely identify this specific job entry and its bullet points"
    }],
    "projects": [{
        "title": "Project Name",
        "technologies": "Technologies Used (if specified)",
        "dates": "Date Range (if specified)",
        "bulletPoints": ["Original bullet point 1", "Original bullet point 2", ...],
        "selector": "CSS selector to uniquely identify this specific project entry and its bullet points"
    }],
    "education": [{
        "degree": "Degree Name",
        "institution": "Institution Name",
        "dates": "Date Range",
        "location": "Location",
        "bulletPoints": ["Original bullet point or achievement 1", ...],
        "selector": "CSS selector to uniquely identify this specific education entry"
    }],
    "skills": {
        "technical": ["Skill 1", "Skill 2", ...],
        "tools": ["Tool 1", "Tool 2", ...],
        "other": ["Other skill 1", ...],
        "selector": "CSS selector to identify the skills section"
    },
    "selectors": {
        "jobSection": "CSS selector for the overall job section container (CRITICAL)",
        "projectSection": "CSS selector for the overall project section container",
        "educationSection": "CSS selector for the overall education section container",
        "skillsSection": "CSS selector for the overall skills section container"
    }
}

IMPORTANT GUIDELINES FOR SELECTOR GENERATION:
1. For job/work experience entries, provide selectors that can uniquely identify each specific job entry AND its associated bullet points list.
2. If the HTML doesn't use IDs or clear class names, create selectors using combinations of:
   - Element hierarchy (e.g., 'section:nth-child(2) > div:nth-child(3)')
   - Text content (e.g., 'div:contains("Company Name")')
   - Attribute selectors (e.g., '[data-section="experience"]')
   - Parent-child relationships (e.g., '.experience-section div:has(h3:contains("Job Title"))')
3. Avoid overly broad selectors that might match multiple unrelated elements.
4. When using :contains(), prefer exact text matches over partial ones.
5. Always test mentally if your selector would uniquely identify the target element.
6. For job entries, provide a selector that captures both the job header info AND its bullet points container.
7. Use multiple alternative selectors separated by commas if needed (e.g., '#job-1, .job-entry, div:contains("Company Name")').
8. For sections, identify both the section container AND the bullet list containers within.

CONTENT EXTRACTION GUIDELINES:
1. Extract ONLY text that actually exists in the HTML. Do not generate or infer content.
2. Include ALL bullet points found in each section, preserving their exact text.
3. For each section entry, include a precise CSS selector that can be used to uniquely identify it in the DOM.
4. Preserve exact text formatting, including case and punctuation.
5. If a field is not found (e.g., no location for a job), omit that field rather than returning empty string.

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
                        content: "You are an AI assistant specialized in parsing resume content and creating precise CSS selectors. You extract the semantic structure, content, and accurate CSS selectors from HTML resumes, organizing it into a clear JSON structure. You are particularly skilled at identifying job experience sections in varied resume formats. You return only valid JSON matching the requested format."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.2,
                max_tokens: 2500,
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
            
            const requiredSections = ['jobs', 'projects', 'education', 'skills', 'selectors'];
            const hasAllSections = requiredSections.every(section => 
                Array.isArray(parsedContent[section]) || 
                (section === 'skills' && typeof parsedContent[section] === 'object') ||
                (section === 'selectors' && typeof parsedContent[section] === 'object')
            );

            if (typeof parsedContent === 'object' && parsedContent !== null && hasAllSections) {
                console.log('Successfully parsed resume content structure');
                
                // Log the selectors for debugging
                console.log('Job section selector:', parsedContent.selectors.jobSection);
                if (parsedContent.jobs && parsedContent.jobs.length > 0) {
                    parsedContent.jobs.forEach((job, index) => {
                        console.log(`Job ${index + 1} selector:`, job.selector);
                    });
                }
                
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
        
        // Use comprehensive selectors to count bullets across different resume formats
        const jobBullets = $('.work-experience li, .experience li, .employment li, .jobs li, .job-experience li, .professional-experience li, section:contains("Experience") li, div:contains("Work Experience") li, div:contains("Employment") li').length;
        const projectBullets = $('.projects li, .portfolio li, .project-section li, section:contains("Project") li, div:contains("Project") li, div:contains("Portfolio") li').length;
        const educationBullets = $('.education li, .education-details li, section:contains("Education") li, div:contains("Education") li').length;
        
        console.log(`Generated bullet counts: Jobs=${jobBullets}, Projects=${projectBullets}, Education=${educationBullets}`);
        
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);
        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));
    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };
