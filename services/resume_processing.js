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

// Updated to use dynamically found sections
function getSectionWordCounts($, foundSections) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Helper to process bullets within a found section element
    const processSection = (sectionElement, sectionType) => {
        if (sectionElement) {
            // Find list items directly within or nested inside the found element
            sectionElement.find('li').each((_, el) => {
                const wordCount = countWordsInBullet($(el).text());
                counts[sectionType].total += wordCount;
                counts[sectionType].bullets++;
            });
        }
    };

    processSection(foundSections.job, 'job');
    processSection(foundSections.project, 'project');
    processSection(foundSections.education, 'education');

    // Calculate average word count or default
    const calculateAverage = (type) => {
        return counts[type].bullets > 0 ? Math.round(counts[type].total / counts[type].bullets) : 15;
    };

    return {
        job: calculateAverage('job'),
        project: calculateAverage('project'),
        education: calculateAverage('education')
    };
}

// Updated to use dynamically found sections
function extractOriginalBullets($, foundSections) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        // Consider adding logic later to find bullets outside identified sections if needed
        // unassigned: []
    };

    // Helper to extract bullets from a found section element
    const extractFromSection = (sectionElement, sectionType) => {
        if (sectionElement) {
            // Find list items directly within or nested inside the found element
            sectionElement.find('li').each((_, bullet) => {
                const bulletText = $(bullet).text().trim();
                // Add only if non-empty and not already present
                if (bulletText && !originalBullets[sectionType].includes(bulletText)) {
                    originalBullets[sectionType].push(bulletText);
                }
            });
        }
    };

    extractFromSection(foundSections.job, 'job');
    extractFromSection(foundSections.project, 'project');
    extractFromSection(foundSections.education, 'education');

    // Potential enhancement: Find any 'li' elements not within the identified sections
    // $('li').each((_, bullet) => {
    //     const bulletText = $(bullet).text().trim();
    //     let foundInSection = false;
    //     for (const type in foundSections) {
    //         if (foundSections[type] && foundSections[type].find(bullet).length > 0) {
    //             foundInSection = true;
    //             break;
    //         }
    //     }
    //     if (!foundInSection && bulletText && !Object.values(originalBullets).flat().includes(bulletText)) {
    //         // Add to a general 'unassigned' category if needed
    //     }
    // });


    return originalBullets;
}

// Function to dynamically find resume sections based on headings
function findResumeSections($) {
    const sections = {
        job: null,
        project: null,
        education: null,
        skills: null
    };
    const sectionKeywords = {
        job: /experience|employment|work/i,
        project: /projects?/i,
        education: /education|academic/i,
        skills: /skills|technologies|competencies/i
    };

    $('h2, h3').each((_, heading) => {
        const headingText = $(heading).text().trim();
        for (const type in sectionKeywords) {
            if (sectionKeywords[type].test(headingText)) {
                // Find the next sibling ul/ol or a ul/ol within the heading's parent next sibling div/section
                let listContainer = $(heading).next('ul, ol');
                if (listContainer.length === 0) {
                    listContainer = $(heading).next('div, section').find('ul, ol').first();
                     // If still not found, check within the heading's parent for ul/ol
                     if (listContainer.length === 0) {
                         listContainer = $(heading).parent().find('ul, ol').first();
                     }
                     // As a last resort for skills, look for a div/section container often used without lists
                     if (listContainer.length === 0 && type === 'skills') {
                         listContainer = $(heading).next('div, section, p');
                         if (listContainer.length === 0) {
                            listContainer = $(heading).parent().find('div, section, p').first();
                         }
                     }
                }


                // If we found a list or container, assign it. Prioritize more specific finds.
                if (listContainer.length > 0 && !sections[type]) {
                     // For sections other than skills, we ideally want the list itself or its direct parent container
                     if (type !== 'skills') {
                         // Check if the found element is the list itself or contains the list
                         let targetElement = listContainer.is('ul, ol') ? listContainer.parent() : listContainer;
                         // If the parent doesn't seem right (e.g., body), take the list itself or the container
                         if (targetElement.is('body') || targetElement.length === 0) {
                            targetElement = listContainer; // Fallback to the list or container itself
                         }
                         // Ensure we select a block-level container if possible
                         if (!targetElement.is('div, section, article, aside')) {
                             targetElement = listContainer.closest('div, section, article, aside');
                             if (targetElement.length === 0) targetElement = listContainer; // Fallback if no container found
                         }
                         sections[type] = targetElement;
                     } else {
                         // For skills, accept the container directly
                         sections[type] = listContainer.first();
                     }
                }
                break; // Move to the next heading once a match is found
            }
        }
    });

    // Basic validation/logging
    for (const type in sections) {
        if (!sections[type]) {
            console.warn(`Could not dynamically find section for: ${type}`);
        } else {
             // console.log(`Found section for ${type}: ${sections[type].prop('tagName')}`);
        }
    }

    return sections;
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

// Updated to accept a single dynamically found section element
async function updateResumeSection($, sectionElement, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache) {

    // Ensure the passed element is valid
    if (!sectionElement || sectionElement.length === 0) {
        console.warn(`Invalid or missing section element provided for type: ${sectionType}. Skipping update.`);
        return; // Exit if the element is not valid
    }

    // Find the primary bullet list (ul or ol) within the section element.
    // Prioritize direct children, then look deeper.
    let bulletList = sectionElement.children('ul, ol').first();
    if (bulletList.length === 0) {
        bulletList = sectionElement.find('ul, ol').first();
    }

    // If no list exists, create one within the section element.
    // Append it rather than replacing content if possible.
    if (bulletList.length === 0) {
        console.log(`No bullet list found in ${sectionType} section, creating one.`);
        sectionElement.append('<ul></ul>'); // Append ensures it goes inside the section container
        bulletList = sectionElement.find('ul').last(); // Find the newly added list
    }

    // Get bullets from cache or generate/tailor them
    let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount);

    // If tailoring and the list has existing items
    if (fullTailoring && bulletList.find('li').length > 0) {
        const existingBullets = bulletList.find('li')
            .map((_, el) => $(el).text().trim()) // Trim text
            .get()
            .filter(text => text.length > 0); // Filter out empty strings

        // Only tailor if there are actual existing bullets
        if (existingBullets.length > 0) {
             console.log(`Tailoring ${existingBullets.length} existing bullets for ${sectionType} section.`);
             bulletPoints = await generateBullets(
                 'tailor', existingBullets,
                 keywords, context, wordLimit, verbTracker // Pass verbTracker here if needed by generateBullets
             );
             // Add newly tailored points back to the cache pool for this section
             bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
        } else {
             console.log(`Full tailoring enabled but no existing bullets found in ${sectionType}, using generated bullets.`);
        }

    }

    // Filter and slice bullets based on usage and target count
    bulletPoints = bulletPoints
        .filter(bp => bp && bp.trim().length > 0) // Ensure bullets are not empty/null
        .filter(bp => !bulletTracker.isUsed(bp) ||
                      bulletTracker.canUseBulletInSection(bp, sectionType))
        .slice(0, targetBulletCount);

    // Shuffle remaining bullets, ensuring verb diversity
    bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);

    // Clear the existing list content and append the new/updated points
    bulletList.empty();
    bulletPoints.forEach(point => {
        if (point && point.trim().length > 0) { // Double-check point validity
            bulletTracker.addBullet(point, sectionType);
            // Verb tracker is handled within shuffleBulletsWithVerbCheck now
            // verbTracker.addVerb(getFirstVerb(point), sectionType);
            bulletList.append(`<li>${point}</li>`);
        }
    });

     console.log(`Updated ${sectionType} section with ${bulletPoints.length} bullets.`);
}

// Updated to accept a single dynamically found section element
async function adjustSectionBullets($, sectionElement, targetCount, sectionType, bulletTracker, keywords, context, bulletCache) {

    // Ensure the passed element is valid
    if (!sectionElement || sectionElement.length === 0) {
        console.warn(`Invalid or missing section element provided for adjustment: ${sectionType}. Skipping.`);
        return; // Exit if the element is not valid
    }

    // Find the primary bullet list (ul or ol) within the section element.
    let bulletList = sectionElement.children('ul, ol').first();
    if (bulletList.length === 0) {
        bulletList = sectionElement.find('ul, ol').first();
    }

    // If no bullet list exists, we can't adjust bullets. Log and return.
    if (bulletList.length === 0) {
        console.warn(`No bullet list found in ${sectionType} section during adjustment. Cannot adjust bullets.`);
        return;
    }

    const bullets = bulletList.find('li');
    const currentCount = bullets.length;

    if (currentCount > targetCount) {
        // Remove excess bullets from the end
        console.log(`Reducing bullets in ${sectionType} from ${currentCount} to ${targetCount}`);
        bullets.slice(targetCount).remove();
    } else if (currentCount < targetCount) {
        // Add missing bullets from the cache
        const needed = targetCount - currentCount;
        console.log(`Adding ${needed} bullets to ${sectionType} (currently ${currentCount}, target ${targetCount})`);
        const cachedBullets = bulletCache.getBulletsForSection(sectionType, needed * 2); // Get more than needed initially
        const validBullets = cachedBullets
            .filter(bp => bp && bp.trim().length > 0) // Ensure valid bullet text
            .filter(bp => !bulletTracker.isUsed(bp)) // Check if already used globally
            .slice(0, needed); // Take only the number needed

        validBullets.forEach(bullet => {
            bulletTracker.addBullet(bullet, sectionType); // Mark as used
            bulletList.append(`<li>${bullet}</li>`);
        });

        if (validBullets.length < needed) {
             console.warn(`Could only add ${validBullets.length} out of ${needed} needed bullets to ${sectionType} from cache.`);
             // Optionally, could attempt to generate more here if strictly required
        }
    }
    // If currentCount === targetCount, do nothing.
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

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' }); // Wait for external resources like CSS

    // No longer injecting custom CSS. Rely on the HTML's own styles.

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

// Updated to accept the dynamically found skills section element
function updateSkillsSection($, keywords, skillsSectionElement) { // Added skillsSectionElement parameter
    return new Promise(async (resolve, reject) => {
        try {
            // Ensure the passed element is valid
            if (!skillsSectionElement || skillsSectionElement.length === 0) {
                console.warn('Skills section element not provided or invalid, skipping update.');
                resolve($); // Resolve without changes
                return;
            }

            const categorizedKeywords = await categorizeKeywords(keywords);
            if (!categorizedKeywords) {
                console.warn('Could not categorize keywords, skills section unchanged');
                resolve($);
                return;
            }

            // Use the provided skillsSectionElement directly
            const skillsSection = skillsSectionElement;

            const categoryMapping = {
                "Languages": "Languages:",
                "Frameworks/Libraries": "Frameworks/Libraries:",
                "Others": "Others (APIs, Services, Protocols):",
                "Machine Learning Libraries": "Machine Learning Libraries:"
            };

            // Clear existing skills content within the section before adding new ones
            // This assumes skills are typically grouped in <p> tags within the section
            skillsSection.find('p:contains("Languages:"), p:contains("Frameworks/Libraries:"), p:contains("Others"), p:contains("Machine Learning Libraries:")').remove();

            Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                    const keywordsText = categorizedKeywords[dataKey].join(', ');
                    // Append new paragraph for the category
                    skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywordsText}</p>`);
                }
            });

            resolve($); // Resolve with the modified Cheerio object
        } catch (error) {
            console.error('Error updating skills section:', error);
            // Resolve even on error to avoid breaking the chain, but log it.
            resolve($);
        }
    });
}

// Update the updateResume function to include skill section modification and dynamic section finding
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);

    // Dynamically find sections first
    const foundSections = findResumeSections($);

    // Pass the found sections to functions that need them
    const sectionWordCounts = getSectionWordCounts($, foundSections); // Pass foundSections
    const originalBullets = extractOriginalBullets($, foundSections); // Pass foundSections

    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();

    // Update the skills section using the dynamically found element
    if (foundSections.skills) {
        // Pass the specific skills element found
        await updateSkillsSection($, keywords, foundSections.skills);
    } else {
        console.warn("Skills section not found dynamically, skipping update.");
    }

    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;

    const keywordString = fullTailoring ?
        keywords.join(', ') :
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate all bullets upfront (doesn't strictly need section elements yet)
    await bulletCache.generateAllBullets($, keywords, 'resume section', 15, verbTracker);

    // Define sections based on dynamically found elements
    const sectionsToProcess = [
        { element: foundSections.job, type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { element: foundSections.project, type: 'project', context: 'for a project', bullets: originalBullets.project },
        { element: foundSections.education, type: 'education', context: 'for education', bullets: originalBullets.education }
    ].filter(s => s.element); // Only process sections that were found

    // Update each found section
    for (const section of sectionsToProcess) {
        // Ensure sectionWordCounts has data for this type, default if not
        const wordLimit = sectionWordCounts[section.type] || 15;

        await updateResumeSection(
            $, section.element, keywordString, section.context, // Use section.element (the Cheerio object)
            fullTailoring, wordLimit,
            bulletTracker, section.type, section.bullets,
            INITIAL_BULLET_COUNT, verbTracker, bulletCache
        );
    }

    // Check and adjust page length
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        // Use a temporary Cheerio instance for PDF check to avoid modifying the main one
        const temp$ = cheerio.load($.html());
        const { exceedsOnePage } = await convertHtmlToPdf(temp$.html());
        if (!exceedsOnePage) break;

        currentBulletCount--;
        console.log(`Resume exceeds one page. Reducing bullet count to target ~${currentBulletCount} per section.`);

        for (const section of sectionsToProcess) {
            // Calculate target count for this section based on the new overall target
             const targetCount = Math.max(
                 MIN_BULLETS,
                 Math.floor(currentBulletCount * (section.type === 'job' ? 1.0 : section.type === 'project' ? 0.8 : 0.6)) // Adjust ratios if needed
             );

            console.log(`Adjusting ${section.type} section to ${targetCount} bullets.`);
            await adjustSectionBullets(
                $, section.element, targetCount, // Use section.element (the Cheerio object)
                section.type, bulletTracker, keywordString,
                section.context, bulletCache
            );
        }
        attempts++;
    }
     if (attempts === 3 && currentBulletCount < MIN_BULLETS) {
        console.warn("Could not fit resume onto one page even after reducing bullets to minimum.");
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

        // Logging of final counts using specific selectors is removed as structure is dynamic.
        // Counts are logged during the update/adjust process within the helper functions.
        console.log('Resume HTML updated dynamically.');

        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }

        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error('Error in customizeResume:', error); // Log the full error
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };