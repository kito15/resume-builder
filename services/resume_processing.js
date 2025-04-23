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

function getSectionWordCounts($) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Find experience/job sections using common heading identifiers
    const jobSections = $('h1, h2, h3, h4, .section-heading, .heading, [class*="experience"], [class*="job"]')
        .filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes('experience') || text.includes('employment') || 
                   text.includes('work history') || text.includes('career');
        })
        .next('div, section, ul, ol')
        .find('li');

    // If specific job-details class exists, include those too
    const specificJobBullets = $('.job-details li');
    const allJobBullets = jobSections.add(specificJobBullets);

    allJobBullets.each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });

    // Find project sections
    const projectSections = $('h1, h2, h3, h4, .section-heading, .heading, [class*="project"]')
        .filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes('project');
        })
        .next('div, section, ul, ol')
        .find('li');
    
    const specificProjectBullets = $('.project-details li');
    const allProjectBullets = projectSections.add(specificProjectBullets);

    allProjectBullets.each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });

    // Find education sections
    const educationSections = $('h1, h2, h3, h4, .section-heading, .heading, [class*="education"]')
        .filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes('education') || text.includes('academic');
        })
        .next('div, section, ul, ol')
        .find('li');
    
    const specificEducationBullets = $('.education-details li');
    const allEducationBullets = educationSections.add(specificEducationBullets);

    allEducationBullets.each((_, el) => {
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

// Function to extract and store original bullets with flexible section detection
function extractOriginalBullets($) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: [] // For any bullets not in a specific section
    };

    // Find job/experience sections and their bullet points
    const jobSections = $('h1, h2, h3, h4, .section-heading, .heading, [class*="experience"], [class*="job"]')
        .filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes('experience') || text.includes('employment') || 
                   text.includes('work history') || text.includes('career');
        })
        .next('div, section, ul, ol');
        
    jobSections.add('.job-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.job.includes(bulletText)) {
                originalBullets.job.push(bulletText);
            }
        });
    });

    // Find project sections and their bullet points
    const projectSections = $('h1, h2, h3, h4, .section-heading, .heading, [class*="project"]')
        .filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes('project');
        })
        .next('div, section, ul, ol');
        
    projectSections.add('.project-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.project.includes(bulletText)) {
                originalBullets.project.push(bulletText);
            }
        });
    });

    // Find education sections and their bullet points
    const educationSections = $('h1, h2, h3, h4, .section-heading, .heading, [class*="education"]')
        .filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes('education') || text.includes('academic');
        })
        .next('div, section, ul, ol');
        
    educationSections.add('.education-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.education.includes(bulletText)) {
                originalBullets.education.push(bulletText);
            }
        });
    });

    // Collect any remaining bullets that might be relevant
    $('li').each((_, bullet) => {
        const bulletText = $(bullet).text().trim();
        if (bulletText && 
            !originalBullets.job.includes(bulletText) && 
            !originalBullets.project.includes(bulletText) && 
            !originalBullets.education.includes(bulletText)) {
            originalBullets.unassigned.push(bulletText);
        }
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

async function updateResumeSection($, sections, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache) {
    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        let bulletList = section.find('ul, ol').first(); // Look for any list type
        
        // Store original list type and any classes for preservation
        let listType = 'ul';
        let listClasses = '';
        let listStyle = '';
        
        if (bulletList.length > 0) {
            // Preserve the type of list (ul or ol)
            listType = bulletList.get(0).tagName.toLowerCase();
            // Preserve any classes on the list
            listClasses = bulletList.attr('class') || '';
            // Preserve any inline style
            listStyle = bulletList.attr('style') || '';
        } else {
            // If no list exists, create one appropriate to the content
            const listContainer = $(`<${listType}></${listType}>`);
            if (listClasses) listContainer.attr('class', listClasses);
            if (listStyle) listContainer.attr('style', listStyle);
            
            // Find the best place to insert the list
            // Look for a div in the section that might contain text content
            const contentDiv = section.find('div, p').first();
            if (contentDiv.length > 0) {
                contentDiv.after(listContainer);
            } else {
                section.append(listContainer);
            }
            bulletList = section.find(listType);
        }

        let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount);
        
        // Preserve existing bullets if doing full tailoring
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

        // Preserve any existing list items and their attributes/classes if possible
        const existingItems = bulletList.find('li');
        
        if (existingItems.length > 0) {
            // If we have existing items, let's update their text content
            // while preserving the element's attributes/classes
            
            // Get a sample li to use for any new items
            const sampleLi = $(existingItems.get(0));
            const liClass = sampleLi.attr('class') || '';
            const liStyle = sampleLi.attr('style') || '';
            
            // Remove extra items if we have more existing than needed
            if (existingItems.length > bulletPoints.length) {
                existingItems.slice(bulletPoints.length).remove();
            }
            
            // Update existing items with new bullet content
            existingItems.each((idx, item) => {
                if (idx < bulletPoints.length) {
                    $(item).text(bulletPoints[idx]);
                    bulletTracker.addBullet(bulletPoints[idx], sectionType);
                    verbTracker.addVerb(getFirstVerb(bulletPoints[idx]), sectionType);
                }
            });
            
            // Add any additional items needed
            if (bulletPoints.length > existingItems.length) {
                for (let i = existingItems.length; i < bulletPoints.length; i++) {
                    const newLi = $(`<li>${bulletPoints[i]}</li>`);
                    
                    // Apply preserved classes and styles
                    if (liClass) newLi.attr('class', liClass);
                    if (liStyle) newLi.attr('style', liStyle);
                    
                    bulletList.append(newLi);
                    bulletTracker.addBullet(bulletPoints[i], sectionType);
                    verbTracker.addVerb(getFirstVerb(bulletPoints[i]), sectionType);
                }
            }
        } else {
            // If no existing items, create new ones
            bulletList.empty();
            bulletPoints.forEach(point => {
                bulletTracker.addBullet(point, sectionType);
                verbTracker.addVerb(getFirstVerb(point), sectionType);
                bulletList.append(`<li>${point}</li>`);
            });
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

    // Minimal CSS to only handle page properties, not override original styling
    const minimalCSS = `
        @page {
            size: Letter;
            margin: 0.25in;
        }
        @media print {
            a {
                text-decoration: none;
                color: inherit;
            }
            body {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
        }
    `;

    // Load content with original styles preserved
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    // Add only minimal print-specific CSS
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        
        // Check for any external stylesheets and ensure they're loaded
        const styleSheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
        return Promise.all(styleSheets.map(link => 
            fetch(link.href)
                .then(res => res.text())
                .then(css => {
                    const style = document.createElement('style');
                    style.textContent = css;
                    document.head.appendChild(style);
                })
                .catch(err => console.error('Could not load stylesheet:', err))
        ));
    }, minimalCSS);

    // Wait for any web fonts to load
    await page.evaluateHandle(() => document.fonts.ready);
    
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
            
            // Find skills section using more flexible selectors
            const skillsSelectors = [
                // Try specific class names first
                '.section-content:first', 
                '.skills-section', 
                '[class*=skill]',
                // Try heading-based identification
                $('h1, h2, h3, h4').filter((_, el) => {
                    const text = $(el).text().toLowerCase();
                    return text.includes('skill') || text.includes('technology') || 
                           text.includes('technical') || text.includes('proficienc');
                }).next('div, section, ul, p'),
                // Use first section as a last resort
                'section:first'
            ];
            
            // Find the first matching element
            let skillsSection = null;
            for (const selector of skillsSelectors) {
                if (typeof selector === 'string') {
                    const found = $(selector);
                    if (found.length > 0) {
                        skillsSection = found.first();
                        break;
                    }
                } else if (selector.length > 0) {
                    skillsSection = selector.first();
                    break;
                }
            }
            
            if (!skillsSection || skillsSection.length === 0) {
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
            
            // Detect if skills are in list format or paragraph format
            const hasList = skillsSection.find('ul, ol').length > 0;
            const paragraphsOrItems = hasList ? 
                skillsSection.find('li') : 
                skillsSection.find('p, div:not(:has(div))');
            
            const existingItems = [];
            paragraphsOrItems.each((_, item) => {
                existingItems.push($(item));
            });
            
            // Determine the formatting pattern from existing items
            const getFormattingPattern = (items) => {
                if (items.length === 0) return 'paragraph';
                
                const hasStrong = items.find('strong').length > 0;
                const hasSpans = items.find('span').length > 0;
                const hasColons = items.text().includes(':');
                
                if (hasStrong) return 'strong';
                if (hasSpans) return 'span';
                if (hasColons) return 'colon';
                return 'paragraph';
            };
            
            const formattingPattern = getFormattingPattern(paragraphsOrItems);
            
            // Get sample item for styling preservation
            const sampleItem = existingItems.length > 0 ? existingItems[0] : null;
            const sampleClass = sampleItem ? sampleItem.attr('class') || '' : '';
            const sampleStyle = sampleItem ? sampleItem.attr('style') || '' : '';
            
            // Function to apply consistent formatting
            const formatKeywordItem = (label, keywords, container, pattern) => {
                const keywordText = keywords.join(', ');
                
                switch (pattern) {
                    case 'strong':
                        return container.html(`<strong>${label}</strong> ${keywordText}`);
                    case 'span':
                        return container.html(`<span>${label}</span> ${keywordText}`);
                    case 'colon':
                        return container.text(`${label} ${keywordText}`);
                    default:
                        return container.text(`${label} ${keywordText}`);
                }
            };
            
            // Create or update skill items
            Object.entries(categoryMapping).forEach(([dataKey, htmlLabel], index) => {
                if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                    const keywords = categorizedKeywords[dataKey];
                    
                    if (index < existingItems.length) {
                        // Update existing item
                        formatKeywordItem(htmlLabel, keywords, existingItems[index], formattingPattern);
                    } else {
                        // Create new item with consistent formatting
                        if (hasList) {
                            const newLi = $('<li></li>');
                            if (sampleClass) newLi.attr('class', sampleClass);
                            if (sampleStyle) newLi.attr('style', sampleStyle);
                            formatKeywordItem(htmlLabel, keywords, newLi, formattingPattern);
                            skillsSection.find('ul, ol').first().append(newLi);
                        } else {
                            const newP = $('<p></p>');
                            if (sampleClass) newP.attr('class', sampleClass);
                            if (sampleStyle) newP.attr('style', sampleStyle);
                            formatKeywordItem(htmlLabel, keywords, newP, formattingPattern);
                            skillsSection.append(newP);
                        }
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

    // Find sections dynamically using heading text and class names
    const findSections = (sectionType) => {
        let selectors = [];
        
        if (sectionType === 'job') {
            // Look for experience/job sections using various selectors
            const expHeadings = $('h1, h2, h3, h4, .section-heading, .heading, [class*="experience"], [class*="job"]')
                .filter((_, el) => {
                    const text = $(el).text().toLowerCase();
                    return text.includes('experience') || text.includes('employment') || 
                           text.includes('work history') || text.includes('career');
                });
                
            // Get the container elements after these headings
            expHeadings.each((_, heading) => {
                const nextElements = $(heading).nextUntil('h1, h2, h3, h4, .section-heading, .heading')
                    .filter('div, section, ul');
                if (nextElements.length > 0) {
                    selectors = selectors.concat(nextElements.toArray());
                } else {
                    // If no appropriate siblings, try parent's children
                    const parent = $(heading).parent();
                    const childContainers = parent.find('> div, > section, > ul').toArray();
                    if (childContainers.length > 0) {
                        selectors = selectors.concat(childContainers);
                    }
                }
            });
            
            // Also include specific class selectors
            $('.job-details, .experience, [class*="job-container"]').each((_, el) => {
                selectors.push(el);
            });
        } 
        else if (sectionType === 'project') {
            const projectHeadings = $('h1, h2, h3, h4, .section-heading, .heading, [class*="project"]')
                .filter((_, el) => {
                    const text = $(el).text().toLowerCase();
                    return text.includes('project');
                });
                
            projectHeadings.each((_, heading) => {
                const nextElements = $(heading).nextUntil('h1, h2, h3, h4, .section-heading, .heading')
                    .filter('div, section, ul');
                if (nextElements.length > 0) {
                    selectors = selectors.concat(nextElements.toArray());
                } else {
                    const parent = $(heading).parent();
                    const childContainers = parent.find('> div, > section, > ul').toArray();
                    if (childContainers.length > 0) {
                        selectors = selectors.concat(childContainers);
                    }
                }
            });
            
            $('.project-details, [class*="project-container"]').each((_, el) => {
                selectors.push(el);
            });
        }
        else if (sectionType === 'education') {
            const eduHeadings = $('h1, h2, h3, h4, .section-heading, .heading, [class*="education"]')
                .filter((_, el) => {
                    const text = $(el).text().toLowerCase();
                    return text.includes('education') || text.includes('academic');
                });
                
            eduHeadings.each((_, heading) => {
                const nextElements = $(heading).nextUntil('h1, h2, h3, h4, .section-heading, .heading')
                    .filter('div, section, ul');
                if (nextElements.length > 0) {
                    selectors = selectors.concat(nextElements.toArray());
                } else {
                    const parent = $(heading).parent();
                    const childContainers = parent.find('> div, > section, > ul').toArray();
                    if (childContainers.length > 0) {
                        selectors = selectors.concat(childContainers);
                    }
                }
            });
            
            $('.education-details, [class*="education-container"]').each((_, el) => {
                selectors.push(el);
            });
        }
        
        // Remove duplicates and convert back to cheerio collection
        return $($.uniqueSort(selectors));
    };

    const sections = [
        { selector: findSections('job'), type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { selector: findSections('project'), type: 'project', context: 'for a project', bullets: originalBullets.project },
        { selector: findSections('education'), type: 'education', context: 'for education', bullets: originalBullets.education }
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
