const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for OpenAI
const openaiApiKey = process.env.OPENAI_API_KEY;
const lmCache = new Map();

// Add dynamic resume section detection using GPT
async function detectResumeStructure(htmlContent) {
    const cacheKey = `resume_structure_${generateHash(htmlContent.substring(0, 1000))}`;
    
    if (lmCache.has(cacheKey)) {
        return lmCache.get(cacheKey);
    }
    
    try {
        const $ = cheerio.load(htmlContent);
        
        // Pre-analyze the document to provide context
        const headings = [];
        $('h1, h2, h3, .section-title, .section-header').each((_, el) => {
            const text = $(el).text().trim();
            if (text) headings.push(text);
        });
        
        // Count bullet points in document
        const bulletLists = {};
        $('ul').each((i, ul) => {
            const liCount = $(ul).find('li').length;
            if (liCount > 0) {
                const nearestHeading = findNearestHeading($, ul);
                bulletLists[`list_${i}`] = {
                    heading: nearestHeading,
                    count: liCount
                };
            }
        });
        
        const prompt = `Analyze this HTML resume to identify precise CSS selectors for each key section. 

IMPORTANT CONTEXT:
- Headings found: ${JSON.stringify(headings)}
- Bullet lists found: ${JSON.stringify(bulletLists)}

TASK: Return a JSON object with these exact keys, each containing the most PRECISE CSS selector that uniquely identifies ONLY that section (not multiple sections):

1. "jobSections": selector for job/experience entries (each job entry, not the entire experience section)
2. "projectSections": selector for project entries (each project, not the entire projects section)  
3. "educationSections": selector for education entries (each education item, not the whole section)
4. "skillsSection": selector for the technical skills/keywords section (the content area, not just the heading)

IMPORTANT RULES:
- Use ONLY selectors that appear in the actual HTML
- Test if your selector works by checking it would select the right elements
- For job/project/education, find selectors that target EACH ENTRY, not just the section container
- Prioritize class selectors over tag selectors whenever possible
- If a section truly doesn't exist, use null
- Prefer using .class names over complex attribute selectors when possible
- If multiple similar elements exist, make the selector specific enough to ONLY select the right ones

HTML to analyze:
${htmlContent.substring(0, 15000)}`;  // Truncate to avoid token limits

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are an HTML analysis expert specialized in identifying precise CSS selectors for resume sections. You need to analyze HTML and return ONLY selectors that will precisely target specific sections of a resume. Be very precise and test your selectors mentally before providing them."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.2,
                max_tokens: 1000,
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
            const proposedStructure = JSON.parse(jsonString);
            
            // Validate selectors to ensure they actually select elements
            const validatedStructure = {
                jobSections: validateSelector($, proposedStructure.jobSections, '.entry, .experience .entry, [class*="job"], [class*="experience"]'),
                projectSections: validateSelector($, proposedStructure.projectSections, '.project, [class*="project"]'),
                educationSections: validateSelector($, proposedStructure.educationSections, '.education, .education-entry, [class*="education"]'),
                skillsSection: validateSelector($, proposedStructure.skillsSection, '.skills, [class*="skill"], .technical, [class*="technical"]')
            };
            
            console.log('Detected resume structure:', validatedStructure);
            
            // Additional analysis - check if sections actually have bullet points
            const hasBullets = {
                job: $(validatedStructure.jobSections).find('li').length > 0,
                project: $(validatedStructure.projectSections).find('li').length > 0,
                education: $(validatedStructure.educationSections).find('li').length > 0
            };
            
            console.log('Sections with bullets:', hasBullets);
            
            // Store structure with bullet info
            const finalStructure = {
                ...validatedStructure,
                hasBullets
            };
            
            lmCache.set(cacheKey, finalStructure);
            return finalStructure;
        } catch (jsonError) {
            console.error('Error parsing JSON from structure detection:', jsonError);
            
            // Try to detect sections directly with cheerio
            const directDetection = detectSectionsDirectly($);
            lmCache.set(cacheKey, directDetection);
            return directDetection;
        }
    } catch (error) {
        console.error('Error detecting resume structure:', error.response?.data || error.message);
        // Try to detect sections directly as fallback
        const $ = cheerio.load(htmlContent);
        const directDetection = detectSectionsDirectly($);
        return directDetection;
    }
}

// Helper function to find the nearest heading to an element
function findNearestHeading($, element) {
    let currentNode = element;
    let headingText = '';
    
    // Look for headings above the element
    while (currentNode.length > 0 && !headingText) {
        // Check if current node is a heading
        if (currentNode.is('h1, h2, h3, h4, h5, h6, .section-title, .section-header')) {
            headingText = currentNode.text().trim();
            break;
        }
        
        // Check preceding siblings
        let prevSibling = currentNode.prev();
        while (prevSibling.length > 0 && !headingText) {
            if (prevSibling.is('h1, h2, h3, h4, h5, h6, .section-title, .section-header')) {
                headingText = prevSibling.text().trim();
                break;
            }
            prevSibling = prevSibling.prev();
        }
        
        // Move up to parent
        currentNode = currentNode.parent();
    }
    
    return headingText || 'Unknown';
}

// Helper function to validate a selector and fall back if needed
function validateSelector($, proposedSelector, fallbackSelector) {
    // If null, empty or invalid selector format
    if (!proposedSelector || typeof proposedSelector !== 'string' || proposedSelector.trim() === '') {
        return fallbackSelector;
    }
    
    try {
        // See if the selector works and selects something
        const elements = $(proposedSelector);
        if (elements.length > 0) {
            return proposedSelector;
        }
    } catch (e) {
        // If selector is invalid syntax
        console.warn(`Invalid selector: ${proposedSelector}`, e.message);
    }
    
    return fallbackSelector;
}

// Direct section detection using common patterns
function detectSectionsDirectly($) {
    // Find experience/job sections
    let jobSections = '';
    const possibleJobSelectors = [
        '.experience .entry', '.entry', '.job-details', '.work-experience .job',
        'div:has(h2:contains("Experience")) .entry', 'div:has(h3:contains("Experience")) .entry',
        'div:has(.section-title:contains("Experience")) + div',
        '.experience-entry', 'section:contains("Experience") .entry'
    ];
    
    for (const selector of possibleJobSelectors) {
        if ($(selector).length > 0) {
            jobSections = selector;
            break;
        }
    }
    
    // Find project sections
    let projectSections = '';
    const possibleProjectSelectors = [
        '.project', '.project-details', '.projects .entry',
        'div:has(h2:contains("Project")) .entry', 'div:has(h3:contains("Project")) .entry',
        'div:has(.section-title:contains("Project")) + div',
        '.project-entry', 'section:contains("Project") .entry'
    ];
    
    for (const selector of possibleProjectSelectors) {
        if ($(selector).length > 0) {
            projectSections = selector;
            break;
        }
    }
    
    // Find education sections
    let educationSections = '';
    const possibleEducationSelectors = [
        '.education .entry', '.education-details', '.education',
        'div:has(h2:contains("Education")) .entry', 'div:has(h3:contains("Education")) .entry',
        'div:has(.section-title:contains("Education")) + div',
        '.education-entry', 'section:contains("Education") .entry'
    ];
    
    for (const selector of possibleEducationSelectors) {
        if ($(selector).length > 0) {
            educationSections = selector;
            break;
        }
    }
    
    // Find skills section
    let skillsSection = '';
    const possibleSkillSelectors = [
        '.skills', '.skills-item', '.skills-section',
        'div:has(h2:contains("Skill"))', 'div:has(h3:contains("Skill"))',
        'div:has(.section-title:contains("Skill"))',
        '.technical-skills', 'section:contains("Skill")',
        'div:has(h2:contains("Technical"))', 'div:contains("Technical Skills")'
    ];
    
    for (const selector of possibleSkillSelectors) {
        if ($(selector).length > 0) {
            skillsSection = selector;
            break;
        }
    }
    
    // Check which sections actually have bullet points
    const hasBullets = {
        job: jobSections ? $(jobSections).find('li').length > 0 : false,
        project: projectSections ? $(projectSections).find('li').length > 0 : false,
        education: educationSections ? $(educationSections).find('li').length > 0 : false
    };
    
    const structure = {
        jobSections,
        projectSections,
        educationSections,
        skillsSection,
        hasBullets
    };
    
    console.log('Detected sections directly:', structure);
    return structure;
}

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

    // Only count job bullets if the section has bullet points
    if (selectors.jobSections && selectors.hasBullets.job) {
        $(selectors.jobSections + ' li').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.job.total += wordCount;
            counts.job.bullets++;
        });
    }

    // Only count project bullets if the section has bullet points
    if (selectors.projectSections && selectors.hasBullets.project) {
        $(selectors.projectSections + ' li').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.project.total += wordCount;
            counts.project.bullets++;
        });
    }

    // Only count education bullets if the section has bullet points  
    if (selectors.educationSections && selectors.hasBullets.education) {
        $(selectors.educationSections + ' li').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.education.total += wordCount;
            counts.education.bullets++;
        });
    }

    // Use defaults for sections without bullets
    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}

// Function to extract and store original bullets
function extractOriginalBullets($, selectors) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: [] // For any bullets not in a specific section
    };

    // Only extract job bullets if the section has bullet points
    if (selectors.jobSections && selectors.hasBullets.job) {
        $(selectors.jobSections).each((_, section) => {
            $(section).find('li').each((_, bullet) => {
                const bulletText = $(bullet).text().trim();
                if (bulletText && !originalBullets.job.includes(bulletText)) {
                    originalBullets.job.push(bulletText);
                }
            });
        });
    }

    // Only extract project bullets if the section has bullet points
    if (selectors.projectSections && selectors.hasBullets.project) {
        $(selectors.projectSections).each((_, section) => {
            $(section).find('li').each((_, bullet) => {
                const bulletText = $(bullet).text().trim();
                if (bulletText && !originalBullets.project.includes(bulletText)) {
                    originalBullets.project.push(bulletText);
                }
            });
        });
    }

    // Only extract education bullets if the section has bullet points
    if (selectors.educationSections && selectors.hasBullets.education) {
        $(selectors.educationSections).each((_, section) => {
            $(section).find('li').each((_, bullet) => {
                const bulletText = $(bullet).text().trim();
                if (bulletText && !originalBullets.education.includes(bulletText)) {
                    originalBullets.education.push(bulletText);
                }
            });
        });
    }

    // Find any additional bullet points not in recognized sections
    $('li').each((_, bullet) => {
        const bulletText = $(bullet).text().trim();
        const inKnownSection = 
            originalBullets.job.includes(bulletText) || 
            originalBullets.project.includes(bulletText) || 
            originalBullets.education.includes(bulletText);
            
        if (bulletText && !inKnownSection) {
            // Check if this is a skills/technical bullet - if so, don't include
            const closestSkillsSection = $(bullet).closest(selectors.skillsSection);
            if (closestSkillsSection.length === 0) {
                originalBullets.unassigned.push(bulletText);
            }
        }
    });

    console.log('Extracted bullet counts:', {
        job: originalBullets.job.length,
        project: originalBullets.project.length,
        education: originalBullets.education.length,
        unassigned: originalBullets.unassigned.length
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
            education: new Set(),
            unassigned: new Set() // For bullets not fitting in specific sections
        };
        this.targetBulletCounts = {
            job: 7,
            project: 6,
            education: 5,
            unassigned: 4 // Fewer for unassigned/miscellaneous bullets
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

    // Set content without adding custom CSS
    await page.setContent(htmlContent);

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

// Helper function to find the best match for a skills section
function findSkillsSection($, skillsSelector) {
    // Try the provided selector first
    if (skillsSelector && typeof skillsSelector === 'string') {
        let skillsSection = $(skillsSelector);
        
        if (skillsSection.length > 0) {
            return skillsSection.first();
        }
    }
    
    // Look for skill section by heading first
    const headingSelectors = [
        'h1:contains("Skills"), h2:contains("Skills"), h3:contains("Skills"), h4:contains("Skills")',
        '.section-title:contains("Skills"), .section-header:contains("Skills")',
        'h1:contains("Technical"), h2:contains("Technical"), h3:contains("Technical")',
        '.section-title:contains("Technical"), .section-header:contains("Technical")'
    ];
    
    for (const selector of headingSelectors) {
        const heading = $(selector);
        if (heading.length > 0) {
            // Try to find the content section related to this heading
            // 1. Try next siblings
            let nextSection = heading.next();
            if (nextSection.length > 0 && 
                (nextSection.find('li').length > 0 || 
                 nextSection.find('span').length > 0 || 
                 nextSection.text().includes(','))) {
                return nextSection;
            }
            
            // 2. Try parent's next sibling
            nextSection = heading.parent().next();
            if (nextSection.length > 0 && 
                (nextSection.find('li').length > 0 || 
                 nextSection.find('span').length > 0 || 
                 nextSection.text().includes(','))) {
                return nextSection;
            }
            
            // 3. Try closest section or div
            const container = heading.closest('section, div');
            if (container.length > 0) {
                // Find content within this container that isn't the heading
                const content = container.children().not(heading);
                if (content.length > 0) {
                    return content;
                }
                return container; // Last resort - return the container itself
            }
        }
    }
    
    // Common skills section patterns - try these as fallbacks
    const contentSelectors = [
        // By content
        'ul:contains("Python"), ul:contains("Java"), ul:contains("JavaScript")',
        'div:contains("Languages:"), div:contains("Technologies:"), div:contains("Frameworks:")',
        // By classes/IDs
        '.skills-container, .skills-list, .skills-items',
        '.skills',
        '#skills',
        '.technical-skills',
        '[class*="skill"]',
        '[id*="skill"]',
        '.skills-section',
        // By structure and keywords
        'div:has(> span:contains("Python"))',
        'div:has(> span:contains("JavaScript"))',
        'div:has(> span:contains("Java"))',
        'div:has(> .skills-item)',
        'section:has(> .skills-item)',
        'div:has(> p:contains("Languages"))'
    ];
    
    // Try each content selector
    for (const selector of contentSelectors) {
        const section = $(selector);
        if (section.length > 0) {
            return section.first();
        }
    }
    
    // Last resort - look for technical skills keywords
    const techKeywords = ['Python', 'Java', 'JavaScript', 'HTML', 'CSS', 'React', 'Angular', 
                        'Vue', 'Node', 'AWS', 'Azure', 'SQL', 'NoSQL', 'MongoDB', 'Docker', 
                        'Kubernetes', 'Git', 'Linux', 'Windows', 'MacOS', 'TypeScript'];
    
    for (const keyword of techKeywords) {
        // Look for elements that contain this keyword but aren't bullet points in job/project sections
        const keywordElements = $(`*:contains("${keyword}")`).not('li');
        
        if (keywordElements.length > 0) {
            // Find the most likely container (one with multiple keywords)
            for (const el of keywordElements.get()) {
                const container = $(el).closest('div, section, p, span');
                if (container.length > 0) {
                    let keywordCount = 0;
                    for (const kw of techKeywords) {
                        if (container.text().includes(kw)) keywordCount++;
                    }
                    
                    // If this container has 3+ tech keywords, it's likely the skills section
                    if (keywordCount >= 3) {
                        return container;
                    }
                }
            }
            
            // If no container with multiple keywords, use the first element's container
            const container = keywordElements.first().closest('div, section, p, span');
            if (container.length > 0) {
                return container;
            }
        }
    }
    
    // If still nothing found, return empty jQuery object
    return $();
}

// Update the function to improve skills section detection
function updateSkillsSection($, keywords, selectors) {
    return new Promise(async (resolve, reject) => {
        try {
            // If we don't have any keywords, just leave the skills section as is
            if (!keywords || keywords.length === 0) {
                console.log('No keywords provided, skills section unchanged');
                resolve($);
                return;
            }
            
            const categorizedKeywords = await categorizeKeywords(keywords);
            if (!categorizedKeywords) {
                console.warn('Could not categorize keywords, skills section unchanged');
                resolve($);
                return;
            }
            
            // Find the skills section using the provided selector or fallbacks
            const skillsSection = findSkillsSection($, selectors.skillsSection);
            
            if (skillsSection.length === 0) {
                console.warn('Skills section not found in resume');
                resolve($);
                return;
            }
            
            console.log('Found skills section:', skillsSection.attr('class') || skillsSection.prop('tagName'));
            
            // Take a snapshot of the section before modifications for comparison
            const originalHtml = skillsSection.html();
            
            // Detect existing category patterns in the skills section
            let existingFormat = 'full'; // default to full replacement
            let categoryTags = [];
            
            // Check for existing category headers in bold or strong text
            skillsSection.find('strong, b').each((_, el) => {
                const text = $(el).text().trim();
                if (text && text.length > 3) {
                    categoryTags.push(text);
                }
            });
            
            // If we found category headers, use them as a pattern
            if (categoryTags.length > 0) {
                existingFormat = 'categories';
                console.log('Skills section has categories:', categoryTags);
            } else if (skillsSection.find('li').length > 2) {
                // If there are list items, we'll integrate keywords into list
                existingFormat = 'list';
                console.log('Skills section uses list format');
            } else if (skillsSection.find('span, .skill-item').length > 2) {
                // If there are spans or skill items, we'll use that format
                existingFormat = 'spans';
                console.log('Skills section uses spans/items format');
            } else if (skillsSection.text().includes(',')) {
                // If comma-separated text, keep that format
                existingFormat = 'comma-list';
                console.log('Skills section uses comma-separated format');
            }
            
            // Adapt category mapping to common structures
            let categoryMapping = {};
            
            // If we found existing categories, try to match our categories to them
            if (existingFormat === 'categories' && categoryTags.length > 0) {
                // Look for language categories
                const languageMatch = categoryTags.find(tag => 
                    tag.toLowerCase().includes('language') || 
                    tag.toLowerCase().includes('programming')
                );
                
                // Look for frameworks/libraries categories
                const frameworkMatch = categoryTags.find(tag => 
                    tag.toLowerCase().includes('framework') || 
                    tag.toLowerCase().includes('library')
                );
                
                // Look for technologies/tools categories
                const techMatch = categoryTags.find(tag => 
                    tag.toLowerCase().includes('tool') || 
                    tag.toLowerCase().includes('tech') ||
                    tag.toLowerCase().includes('platform')
                );
                
                // Look for ML category
                const mlMatch = categoryTags.find(tag => 
                    tag.toLowerCase().includes('machine') || 
                    tag.toLowerCase().includes('ml')
                );
                
                // Use existing categories when possible
                categoryMapping = {
                    "Languages": languageMatch || "Languages:",
                    "Frameworks/Libraries": frameworkMatch || "Frameworks/Libraries:",
                    "Others": techMatch || "Technologies:",
                    "Machine Learning Libraries": mlMatch || "Machine Learning:"
                };
            } else {
                // Default mapping
                categoryMapping = {
                    "Languages": "Languages:",
                    "Frameworks/Libraries": "Frameworks/Libraries:",
                    "Others": "Technologies:",
                    "Machine Learning Libraries": "Machine Learning:"
                };
            }
            
            // Handle different formats
            if (existingFormat === 'categories') {
                // Look for existing categories and update them
                Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                    if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                        const keywords = categorizedKeywords[dataKey].join(', ');
                        let found = false;
                        
                        // Try to find a matching category
                        skillsSection.find('strong, b').each((_, el) => {
                            const text = $(el).text().trim();
                            const parent = $(el).parent();
                            
                            // Check if this element matches our category
                            if (text.includes(dataKey) || 
                                (dataKey === "Languages" && text.toLowerCase().includes('language')) ||
                                (dataKey === "Others" && text.toLowerCase().includes('tech')) ||
                                (dataKey === "Frameworks/Libraries" && 
                                 (text.toLowerCase().includes('framework') || text.toLowerCase().includes('library')))) {
                                
                                // Handle different parent structures
                                if (parent.is('p, div, span')) {
                                    // Format: <p><strong>Category:</strong> Items</p>
                                    
                                    // Save the category label
                                    const label = $(el).text();
                                    
                                    // Clear parent and re-add the category with new keywords
                                    parent.html('');
                                    parent.append($('<strong>').text(label));
                                    parent.append(` ${keywords}`);
                                } else {
                                    // Other structure - just add after the element
                                    $(el).next().remove(); // Remove existing text node
                                    $(el).after(` ${keywords}`);
                                }
                                found = true;
                                return false; // break out of .each()
                            }
                        });
                        
                        if (!found) {
                            // If no matching category, append a new one
                            skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywords}</p>`);
                        }
                    }
                });
            } else if (existingFormat === 'list') {
                // Don't replace the list - merge our keywords into it
                let allKeywords = [];
                Object.values(categorizedKeywords).forEach(keywordArray => {
                    allKeywords = [...allKeywords, ...keywordArray];
                });
                
                // Get existing list
                const ul = skillsSection.find('ul').first();
                const existingItems = new Set();
                
                // Collect existing items to avoid duplicates
                ul.find('li').each((_, item) => {
                    existingItems.add($(item).text().trim().toLowerCase());
                });
                
                // Add new items that aren't already there
                allKeywords.forEach(keyword => {
                    if (!existingItems.has(keyword.toLowerCase())) {
                        ul.append(`<li>${keyword}</li>`);
                    }
                });
            } else if (existingFormat === 'spans') {
                // Get all the keywords we want to include
                let allKeywords = [];
                Object.values(categorizedKeywords).forEach(keywordArray => {
                    allKeywords = [...allKeywords, ...keywordArray];
                });
                
                // Find what element wrap is used
                const wrapElement = skillsSection.find('span, .skill-item').first();
                const wrapperTag = wrapElement.prop('tagName').toLowerCase();
                const wrapperClass = wrapElement.attr('class') || '';
                
                // Get existing keywords to avoid duplicates
                const existingItems = new Set();
                skillsSection.find(wrapperTag).each((_, item) => {
                    existingItems.add($(item).text().trim().toLowerCase());
                });
                
                // Add new spans for new keywords
                allKeywords.forEach(keyword => {
                    if (!existingItems.has(keyword.toLowerCase())) {
                        if (wrapperClass) {
                            skillsSection.append(`<${wrapperTag} class="${wrapperClass}">${keyword}</${wrapperTag}> `);
                        } else {
                            skillsSection.append(`<${wrapperTag}>${keyword}</${wrapperTag}> `);
                        }
                    }
                });
            } else if (existingFormat === 'comma-list') {
                // Get comma-separated text content
                let text = skillsSection.text().trim();
                
                // All keywords as a flat list
                let allKeywords = [];
                Object.values(categorizedKeywords).forEach(keywordArray => {
                    allKeywords = [...allKeywords, ...keywordArray];
                });
                
                // Parse existing keywords
                const existingKeywords = text.split(/,\s*/).map(k => k.trim().toLowerCase());
                const existingSet = new Set(existingKeywords);
                
                // Find keywords not already in the list
                const newKeywords = allKeywords.filter(k => !existingSet.has(k.toLowerCase()));
                
                if (newKeywords.length > 0) {
                    // Preserve exact structure
                    if (skillsSection.children().length === 0) {
                        // Simple text node
                        skillsSection.text(text + (text.endsWith(',') ? ' ' : ', ') + newKeywords.join(', '));
                    } else {
                        // More complex structure - just append
                        const lastChild = skillsSection.children().last();
                        lastChild.after(`, ${newKeywords.join(', ')}`);
                    }
                }
            } else {
                // Only do full replacement if we can't determine structure or for simple containers
                if (skillsSection.children().length <= 1) {
                    // Check if this is a very simple container before replacing entirely
                    skillsSection.empty();
                    Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                        if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                            const keywords = categorizedKeywords[dataKey].join(', ');
                            skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywords}</p>`);
                        }
                    });
                } else {
                    // For complex structures, just append our sections
                    console.log('Complex skill section detected, appending keywords without replacing');
                    Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                        if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                            // Check if this category already exists
                            let categoryExists = false;
                            skillsSection.find('strong, b').each((_, el) => {
                                if ($(el).text().trim().toLowerCase().includes(dataKey.toLowerCase())) {
                                    categoryExists = true;
                                    return false; // break loop
                                }
                            });
                            
                            if (!categoryExists) {
                                const keywords = categorizedKeywords[dataKey].join(', ');
                                skillsSection.append(`<p><strong>${htmlLabel}</strong> ${keywords}</p>`);
                            }
                        }
                    });
                }
            }
            
            // Check if we made any changes
            if (skillsSection.html() === originalHtml) {
                console.log('No changes were made to skills section');
            } else {
                console.log('Successfully updated skills section');
            }
            
            resolve($);
        } catch (error) {
            console.error('Error updating skills section:', error);
            resolve($); // Resolve anyway to avoid breaking the process
        }
    });
}

// Update the updateResume function to include skill section modification
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const resumeStructure = await detectResumeStructure(htmlContent);
    const sectionWordCounts = getSectionWordCounts($, resumeStructure);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Extract original bullets before any modifications
    const originalBullets = extractOriginalBullets($, resumeStructure);
    
    // Update the skills section with keywords
    await updateSkillsSection($, keywords, resumeStructure);
    
    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;
    
    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate all bullets upfront
    const allBullets = await bulletCache.generateAllBullets($, keywords, 'resume section', 15, verbTracker);

    // Create section configurations, only include sections that exist in the resume AND have bullet points
    const sections = [];
    
    // Add job section if found and has bullet points
    if (resumeStructure.jobSections && 
        $(resumeStructure.jobSections).length > 0 && 
        resumeStructure.hasBullets.job) {
        sections.push({ 
            selector: $(resumeStructure.jobSections), 
            type: 'job', 
            context: 'for a job experience', 
            bullets: originalBullets.job 
        });
    }
    
    // Add project section if found and has bullet points
    if (resumeStructure.projectSections && 
        $(resumeStructure.projectSections).length > 0 && 
        resumeStructure.hasBullets.project) {
        sections.push({ 
            selector: $(resumeStructure.projectSections), 
            type: 'project', 
            context: 'for a project', 
            bullets: originalBullets.project 
        });
    }
    
    // Add education section if found and has bullet points
    if (resumeStructure.educationSections && 
        $(resumeStructure.educationSections).length > 0 && 
        resumeStructure.hasBullets.education) {
        sections.push({ 
            selector: $(resumeStructure.educationSections), 
            type: 'education', 
            context: 'for education', 
            bullets: originalBullets.education 
        });
    }
    
    // If we have unassigned bullets, only try to distribute them to appropriate sections with existing bullets
    if (originalBullets.unassigned.length > 0) {
        // Only use unassigned bullets for sections that already have bullets
        const sectionsWithBullets = sections.filter(s => s.bullets && s.bullets.length > 0);
        
        if (sectionsWithBullets.length > 0) {
            // Find most appropriate section (prefer job section)
            const jobSection = sectionsWithBullets.find(s => s.type === 'job');
            if (jobSection) {
                jobSection.bullets = [...jobSection.bullets, ...originalBullets.unassigned];
            } else {
                // Or first available section with bullets
                sectionsWithBullets[0].bullets = [...sectionsWithBullets[0].bullets, ...originalBullets.unassigned];
            }
        }
    }
    
    // If no sections were found at all, or no sections have bullet points, just return the original HTML
    if (sections.length === 0) {
        console.warn('No sections with bullet points found in resume');
        return $.html(); // Return unmodified HTML
    }

    console.log(`Found ${sections.length} sections with bullet points to process`);
    
    // Update each section with its specific context
    for (const section of sections) {
        await updateResumeSection(
            $, section.selector, keywordString, section.context,
            fullTailoring, sectionWordCounts[section.type] || 15, // Fallback word count if not found
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

        // Detect structure before processing to log original state
        const $ = cheerio.load(htmlContent);
        const resumeStructure = await detectResumeStructure(htmlContent);
        
        const originalBullets = {
            job: resumeStructure.hasBullets.job ? $(resumeStructure.jobSections + ' li').length : 0,
            project: resumeStructure.hasBullets.project ? $(resumeStructure.projectSections + ' li').length : 0,
            education: resumeStructure.hasBullets.education ? $(resumeStructure.educationSections + ' li').length : 0
        };
        
        console.log('Original bullet counts:', originalBullets);
        
        // Process resume
        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        // Check updated state
        const $updated = cheerio.load(updatedHtmlContent);
        
        const jobBullets = resumeStructure.hasBullets.job ? 
            $updated(resumeStructure.jobSections + ' li').length : 0;
            
        const projectBullets = resumeStructure.hasBullets.project ? 
            $updated(resumeStructure.projectSections + ' li').length : 0;
            
        const educationBullets = resumeStructure.hasBullets.education ? 
            $updated(resumeStructure.educationSections + ' li').length : 0;
        
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

module.exports = { customizeResume, detectResumeStructure };
