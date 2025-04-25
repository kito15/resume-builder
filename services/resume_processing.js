const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for OpenAI
const openaiApiKey = process.env.OPENAI_API_KEY;
// lmCache removed as per request

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

// Update getSectionWordCounts to use dynamic selectors
function getSectionWordCounts($, dynamicSelectors) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Helper function to count words in bullets for a given selector
    const countWordsForSelector = (selector, sectionType) => {
        if (selector && typeof selector === 'string') {
            // Find list items (li) within the identified selector (ul or ol)
            // This assumes the selector points to the list container (ul/ol)
            try {
                 $(selector).find('li').each((_, el) => {
                    const wordCount = countWordsInBullet($(el).text());
                    counts[sectionType].total += wordCount;
                    counts[sectionType].bullets++;
                });
            } catch (e) {
                 console.error(`Error processing selector "${selector}" for section ${sectionType}:`, e);
            }
        } else {
             console.warn(`Invalid or missing selector for section ${sectionType} in getSectionWordCounts.`);
        }
    };

    countWordsForSelector(dynamicSelectors.job, 'job');
    countWordsForSelector(dynamicSelectors.project, 'project');
    countWordsForSelector(dynamicSelectors.education, 'education');

    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}
// New function to dynamically identify bullet list selectors using LLM
async function identifyBulletListSelectors($) {
    const htmlBody = $('body').html(); // Get the main content
    if (!htmlBody || htmlBody.trim().length < 100) {
        console.error("HTML body content is too short or missing for LLM analysis.");
        // Return default selectors as a fallback, though this contradicts the goal
        // Consider throwing an error or returning null/empty object
        return {
            job: '.job-details ul', 
            project: '.project-details ul', 
            education: '.education-details ul'
        };
    }

    // Limit the HTML size sent to the LLM if necessary (e.g., first 15000 chars)
    const truncatedHtml = htmlBody.length > 15000 ? htmlBody.substring(0, 15000) + '...' : htmlBody;

    const prompt = `Analyze the following HTML structure of a resume. Identify the most specific CSS selectors for the unordered lists (ul) or ordered lists (ol) that contain the main achievement bullet points for each of the standard resume sections: Professional Experience (or Work Experience), Projects, and Education.

Return ONLY a JSON object mapping the section type ("job", "project", "education") to its corresponding bullet list CSS selector.

Example HTML Snippet:
<div class="experience-section">
  <h2>Work Experience</h2>
  <div class="job-entry">
    <h3>Software Engineer</h3>
    <ul class="achievements">
      <li>Developed feature X...</li>
      <li>Optimized Y...</li>
    </ul>
  </div>
</div>
<section id="projects">
  <h2>Projects</h2>
  <div class="project-item">
    <h4>My Awesome App</h4>
    <ol class="project-bullets">
      <li>Built using React...</li>
    </ol>
  </div>
</section>

Expected JSON Output for Example:
{
  "job": ".experience-section .job-entry ul.achievements",
  "project": "#projects .project-item ol.project-bullets",
  "education": ".education-section .school-details ul" // Example if education section existed
}

If a section or its bullet list cannot be reliably identified, return null for that section's selector.

HTML to analyze:
\`\`\`html
${truncatedHtml}
\`\`\`
`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano", // Or another suitable model
                messages: [
                    {
                        role: "system",
                        content: "You are an AI assistant specialized in parsing HTML resume structures to find CSS selectors for bullet point lists within standard sections (job experience, projects, education)."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.2, // Lower temperature for more deterministic selector identification
                max_tokens: 500,
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
            const selectors = JSON.parse(jsonString);
            // Basic validation
            if (typeof selectors.job === 'string' && typeof selectors.project === 'string' && typeof selectors.education === 'string') {
                 console.log("LLM identified selectors:", selectors);
                 return selectors;
            } else {
                 console.error('LLM response did not contain valid string selectors for all sections:', selectors);
                 // Fallback or throw error
                 return { job: null, project: null, education: null };
            }
        } catch (jsonError) {
            console.error('Error parsing JSON selectors from LLM response:', jsonError, 'Raw content:', content);
            // Fallback or throw error
            return { job: null, project: null, education: null };
        }
    } catch (error) {
        console.error('Error calling OpenAI for selector identification:', error.response?.data || error.message);
         // Fallback or throw error
        return { job: null, project: null, education: null };
    }
}

// Update extractOriginalBullets to use dynamic selectors
function extractOriginalBullets($, dynamicSelectors) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: [] // Keep unassigned for potential future use or manual fallback
    };

    // Helper function to extract bullets for a given selector
    const extractForSelector = (selector, sectionType) => {
         if (selector && typeof selector === 'string') {
             try {
                 // Find list items (li) within the identified selector (ul or ol)
                 $(selector).find('li').each((_, bullet) => {
                     const bulletText = $(bullet).text().trim();
                     // Add to the specific section if text exists and is not duplicate
                     if (bulletText && !originalBullets[sectionType].includes(bulletText)) {
                         originalBullets[sectionType].push(bulletText);
                     }
                 });
             } catch (e) {
                 console.error(`Error processing selector "${selector}" for section ${sectionType} in extractOriginalBullets:`, e);
             }
         } else {
              console.warn(`Invalid or missing selector for section ${sectionType} in extractOriginalBullets.`);
         }
    };

    // Extract bullets using dynamic selectors
    extractForSelector(dynamicSelectors.job, 'job');
    extractForSelector(dynamicSelectors.project, 'project');
    extractForSelector(dynamicSelectors.education, 'education');

    // Note: The 'unassigned' part is tricky without knowing the structure.
    // We could potentially find all 'li' elements and subtract the ones already assigned,
    // but that might be unreliable. Leaving it empty for now.

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

// BulletCache class removed as per request

async function updateResumeSection($, listElements, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker /*, bulletCache removed */) {
    // The 'listElements' argument is now a Cheerio object containing the identified <ul> or <ol> elements
    for (let i = 0; i < listElements.length; i++) {
        const bulletList = listElements.eq(i); // This is the actual <ul> or <ol> element

        // No need to find 'ul' within the section, as 'bulletList' is the list itself.
        // Also, no need to append a 'ul' because the selector should have found an existing one.
        // If the selector was null/invalid, this function wouldn't be called from updateResume.
        // We might add a check here just in case the selector found something unexpected.
        if (!bulletList.is('ul, ol')) {
             console.warn(`Selector for ${sectionType} did not resolve to a list element. Skipping bullet update for this element.`);
             continue;
        }

        // let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount); // Removed BulletCache usage
        let bulletPoints = []; // Initialize empty, will generate below

        if (fullTailoring && bulletList.find('li').length > 0) {
            const existingBullets = bulletList.find('li')
                .map((_, el) => $(el).text())
                .get();
                
            bulletPoints = await generateBullets(
                'tailor', existingBullets,
                keywords, context, wordLimit, verbTracker
            );
            
            // bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType)); // Removed BulletCache usage
        } else {
             // If not tailoring existing or no existing bullets, generate new ones directly
             bulletPoints = await generateBullets(
                'generate',
                null, // No existing bullets to enhance
                keywords,
                context,
                wordLimit,
                verbTracker
            );
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

// Update adjustSectionBullets to use passed Cheerio object (removed BulletCache)
async function adjustSectionBullets($, listElements, targetCount, sectionType, bulletTracker, keywords, context /*, bulletCache removed */) {
    // The 'listElements' argument is now a Cheerio object containing the identified <ul> or <ol> elements
    // The 'listElements' argument is now a Cheerio object containing the identified <ul> or <ol> elements
    listElements.each((_, listElement) => {
        const bulletList = $(listElement); // This is the actual <ul> or <ol> element

        // Check if it's actually a list element
        if (!bulletList.is('ul, ol')) {
             console.warn(`Element passed to adjustSectionBullets for ${sectionType} is not a list. Skipping adjustment.`);
             return; // Skip to the next element in the Cheerio object
        }

        const bullets = bulletList.find('li'); // Find li elements within the list
        const currentCount = bullets.length;

        if (currentCount > targetCount) {
            // Remove excess bullets from the end
            bullets.slice(targetCount).remove();
        } else if (currentCount < targetCount) {
            // TODO: Need a way to get additional bullets without BulletCache
            // For now, just log a warning or potentially call generateBullets again?
            // Let's leave it empty for now, as the primary goal is removal.
            const validBullets = [];
            console.warn(`Section ${sectionType} needs ${targetCount - currentCount} more bullets, but BulletCache is removed. Add logic to fetch/generate more.`);
            // const cachedBullets = []; // bulletCache.getBulletsForSection(sectionType, targetCount - currentCount); // Removed
            // const validBullets = cachedBullets
            //     .filter(bp => !bulletTracker.isUsed(bp))
            //     .slice(0, targetCount - currentCount);

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

    // Removed customCSS block to preserve original styling
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' }); // Wait for content and network

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
    
    // Caching removed as per request
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
            // lmCache.set(cacheKey, categorized); // Caching removed
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
            // lmCache.set(cacheKey, fallbackCategories); // Caching removed
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

// Update the updateResume function to use dynamic selectors
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);

    // Dynamically identify selectors first
    const dynamicSelectors = await identifyBulletListSelectors($);
    // TODO: Add robust error handling if selectors are null

    // Pass dynamic selectors to functions that need them
    const sectionWordCounts = getSectionWordCounts($, dynamicSelectors);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    // const bulletCache = new BulletCache(); // Removed BulletCache instantiation
    
    // Extract original bullets using dynamic selectors
    const originalBullets = extractOriginalBullets($, dynamicSelectors);
    
    // Update the skills section with keywords (Skills section identification might also need to be dynamic later)
    await updateSkillsSection($, keywords);
    
    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;
    
    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Use dynamic selectors for section processing
    const sections = [
        // Use the selector identified by the LLM. Fallback needed if null.
        { selectorString: dynamicSelectors.job, type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { selectorString: dynamicSelectors.project, type: 'project', context: 'for a project', bullets: originalBullets.project },
        { selectorString: dynamicSelectors.education, type: 'education', context: 'for education', bullets: originalBullets.education }
    ];

    // Update each section with its specific context using dynamic selectors
    for (const section of sections) {
         if (section.selectorString) { // Only process if a selector was found
            await updateResumeSection(
                $, $(section.selectorString), // Pass the Cheerio object for the identified section(s)
                keywordString, section.context,
                fullTailoring, sectionWordCounts[section.type], // sectionWordCounts needs update for dynamic selectors
                bulletTracker, section.type, section.bullets, // originalBullets needs update for dynamic selectors
                INITIAL_BULLET_COUNT, verbTracker
            );
        } else {
             console.warn(`Skipping update for section type '${section.type}' as no selector was identified.`);
        }
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
             if (section.selectorString) { // Only adjust if a selector was found
                const adjustedCount = Math.max(
                    MIN_BULLETS,
                    Math.floor(currentBulletCount * (section.type === 'job' ? 1 : 0.8)) // Adjust ratio as needed
                );
                await adjustSectionBullets(
                    $, $(section.selectorString), // Pass the Cheerio object
                    adjustedCount,
                    section.type, bulletTracker, keywordString,
                    section.context
                );
            }
        }
        attempts++;
    }

    // Return both the updated HTML and the selectors used
    return { updatedHtml: $.html(), selectors: dynamicSelectors };
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

        // updateResume now returns an object: { updatedHtml, selectors }
        const result = await updateResume(htmlContent, keywords, fullTailoring);
        const updatedHtmlContent = result.updatedHtml;
        const finalSelectors = result.selectors; // Selectors used in the update process
        
        const $ = cheerio.load(updatedHtmlContent);

        // Helper function to safely count bullets using dynamic selectors
        const countBullets = (selector) => {
            if (selector && typeof selector === 'string') {
                try {
                    return $(selector).find('li').length;
                } catch (e) {
                    console.error(`Error counting bullets with selector "${selector}":`, e);
                    return 0; // Return 0 if selector is invalid
                }
            }
            return 0; // Return 0 if selector is null or not a string
        };

        const jobBullets = countBullets(finalSelectors.job);
        const projectBullets = countBullets(finalSelectors.project);
        const educationBullets = countBullets(finalSelectors.education);
        
        console.log(`Generated bullet counts (using dynamic selectors): Jobs=${jobBullets}, Projects=${projectBullets}, Education=${educationBullets}`);
        console.log(`Selectors used: Job='${finalSelectors.job}', Project='${finalSelectors.project}', Education='${finalSelectors.education}'`);
        
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
