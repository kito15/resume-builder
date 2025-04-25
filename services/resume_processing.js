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

// Add function to get first verb from bullet point
function getFirstVerb(bulletText) {
    return bulletText.trim().split(/\s+/)[0].toLowerCase();
}

// Generate or tailor bullet points using OpenAI API
async function generateBullets(mode, existingBullets, keywords, context, wordLimit = 15) { // Default wordLimit
    const basePrompt = `You are a specialized resume bullet point optimizer. Engage in chain-of-thought reasoning: before generating or enhancing resume bullets, think out loud—reflect step by step on the user's input, context, and keywords, justifying each keyword and technology choice to ensure coherent, ATS-friendly, and relevant results. Avoid illogical pairings (e.g., Apex with Java). After your chain-of-thought, generate or enhance resume bullets following these strict rules:

FORMATTING RULES:
1. Every bullet MUST start with '>>' (no space after)
2. One specific metric per bullet (%, $, time, or quantity)
3. Each bullet MUST begin with a strong action verb
4. Try to avoid reusing the same starting verb across bullet points
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
        : `${basePrompt}\n\nTASK: Generate up to 10 achievement-focused bullets ${context} with concrete metrics and varied action verbs.`; // Reduced default generation count

    try {
        // Use a simple cache for generated bullets based on prompt hash
        const promptHash = generateHash(prompt);
        if (lmCache.has(promptHash)) {
            return lmCache.get(promptHash);
        }

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
        const generatedBullets = bullets.map(bullet =>
            bullet.replace(/^>>\s*/, '')
                  .replace(/\*\*/g, '')
                  .replace(/\s*\([^)]*\)$/, '')
        );

        // Cache the result
        lmCache.set(promptHash, generatedBullets);
        return generatedBullets;

    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}


// Function to update a specific section's bullet points using dynamically identified container
async function updateResumeSection($, containerSelector, keywords, context, fullTailoring, targetBulletCount, wordLimit = 15) {
    const sectionContainer = $(containerSelector);
    if (sectionContainer.length === 0) {
        console.warn(`Container not found for selector: ${containerSelector}`);
        return;
    }

    let bulletList = sectionContainer.find('ul, ol').first(); // Find first ul or ol

    // If no list exists, try to append one to the container
    if (bulletList.length === 0) {
        sectionContainer.append('<ul></ul>');
        bulletList = sectionContainer.find('ul').first();
        if (bulletList.length === 0) {
             console.warn(`Could not find or create bullet list in container: ${containerSelector}`);
             return; // Cannot proceed without a list
        }
    }

    let bulletPoints = [];
    const existingBulletElements = bulletList.find('li');
    const existingBulletsText = existingBulletElements.map((_, el) => $(el).text()).get();

    if (fullTailoring && existingBulletsText.length > 0) {
        // Tailor existing bullets
        bulletPoints = await generateBullets(
            'tailor',
            existingBulletsText,
            keywords,
            context,
            wordLimit
        );
    } else {
        // Generate new bullets
        bulletPoints = await generateBullets(
            'generate',
            null, // No existing bullets to enhance
            keywords,
            context,
            wordLimit
        );
    }

    // Limit to target count and shuffle
    bulletPoints = shuffleArray(bulletPoints).slice(0, targetBulletCount);

    // Replace existing bullets
    bulletList.empty();
    bulletPoints.forEach(point => {
        bulletList.append(`<li>${point}</li>`);
    });
}

// Function to adjust bullet count in a specific section's container
async function adjustSectionBullets($, containerSelector, targetCount, keywords, context, wordLimit = 15) {
    const sectionContainer = $(containerSelector);
     if (sectionContainer.length === 0) {
        console.warn(`Container not found for selector: ${containerSelector}`);
        return;
    }
    const bulletList = sectionContainer.find('ul, ol').first();
     if (bulletList.length === 0) {
        console.warn(`Bullet list not found in container: ${containerSelector}`);
        return; // Cannot adjust if no list
    }

    const bullets = bulletList.find('li');
    const currentCount = bullets.length;

    if (currentCount > targetCount) {
        // Remove excess bullets from the end
        bullets.slice(targetCount).remove();
    } else if (currentCount < targetCount) {
        // Generate additional bullets needed
        const bulletsToAddCount = targetCount - currentCount;
        const existingBulletsText = bullets.map((_, el) => $(el).text()).get(); // Get current bullets to avoid duplicates if possible
        
        // Generate slightly more bullets than needed to allow filtering
        const newBullets = await generateBullets(
            'generate',
            null, // Generate fresh ones
            keywords,
            context,
            wordLimit
        );

        // Filter out bullets already present (simple text match)
        const uniqueNewBullets = newBullets.filter(bp => !existingBulletsText.includes(bp));

        // Append the required number of unique new bullets
        uniqueNewBullets.slice(0, bulletsToAddCount).forEach(bullet => {
            bulletList.append(`<li>${bullet}</li>`);
        });
    }
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

    // Set content - The user's HTML should contain its own styling
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' }); // Wait for potential external resources

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

// Update categorizeKeywords function to use OpenAI API (Simplified Prompt & Parsing)
async function categorizeKeywords(keywords) {
    if (!keywords || keywords.length === 0) return null;

    const cacheKey = `categorize_v3_${keywords.sort().join(',')}`; // Updated cache key version

    if (lmCache.has(cacheKey)) {
        return lmCache.get(cacheKey);
    }

    try {
        // Simplified prompt asking for plain text lists
        const prompt = `Analyze the provided keywords for relevance to Applicant Tracking Systems (ATS) focused on technical roles. Select ONLY the most impactful technical skills, tools, platforms, and specific methodologies based on the criteria below.

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
- Redundant terms if a more specific one exists (e.g., prefer 'REST APIs' over 'API' or 'APIs'; prefer 'Agile Methodologies' over 'Agile').

Keywords to analyze and select from: ${keywords.join(', ')}

Return the SELECTED and CATEGORIZED keywords ONLY. Use the following format exactly:
Languages: [comma-separated list of selected language keywords]
Frameworks/Libraries: [comma-separated list of selected framework/library keywords]
Machine Learning Libraries: [comma-separated list of selected ML library keywords]
Others: [comma-separated list of selected other technical keywords]

If a category has no selected keywords, write 'None'. Do NOT include explanations or any other text.`;

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano", // Consider gpt-4-turbo-preview if needing more complex understanding
                messages: [
                    { role: "system", content: "You are an AI trained to categorize technical keywords for resumes into specific plain text lists." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.2, // Lower temperature for more deterministic output
                max_tokens: 1000, // Reduced max tokens as JSON is not needed
                top_p: 1
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );

        const content = response.data.choices[0].message.content.trim();
        const categorized = { // Initialize structure
            "Languages": [],
            "Frameworks/Libraries": [],
            "Machine Learning Libraries": [],
            "Others": []
        };

        // Parse the plain text response
        const lines = content.split('\n');
        lines.forEach(line => {
            const parts = line.split(':');
            if (parts.length === 2) {
                const category = parts[0].trim();
                const keywordsString = parts[1].trim();
                if (keywordsString.toLowerCase() !== 'none' && keywordsString.length > 0) {
                    const keywordsList = keywordsString.split(',').map(k => k.trim()).filter(k => k.length > 0);
                    if (category === "Languages" && categorized.hasOwnProperty("Languages")) {
                        categorized["Languages"] = keywordsList;
                    } else if (category === "Frameworks/Libraries" && categorized.hasOwnProperty("Frameworks/Libraries")) {
                        categorized["Frameworks/Libraries"] = keywordsList;
                    } else if (category === "Machine Learning Libraries" && categorized.hasOwnProperty("Machine Learning Libraries")) {
                        categorized["Machine Learning Libraries"] = keywordsList;
                    } else if (category === "Others" && categorized.hasOwnProperty("Others")) {
                        categorized["Others"] = keywordsList;
                    }
                }
            }
        });

        // Validate if any keywords were categorized, otherwise fallback
        const totalCategorized = Object.values(categorized).reduce((sum, arr) => sum + arr.length, 0);
        if (totalCategorized === 0) {
             console.warn("LLM did not categorize any keywords correctly. Falling back.");
             categorized["Others"] = keywords; // Fallback: put all in Others
        }


        lmCache.set(cacheKey, categorized);
        return categorized;

    } catch (error) {
        console.error('Error categorizing keywords:', error.response?.data || error.message);
         // Fallback on error
         const fallbackCategories = {
             "Languages": [], "Frameworks/Libraries": [], "Machine Learning Libraries": [], "Others": keywords
         };
         lmCache.set(cacheKey, fallbackCategories); // Cache fallback on error too
         return fallbackCategories;
    }
}

// Update updateSkillsSection to handle the new categorizedKeywords format and find skills section dynamically
async function updateSkillsSection($, keywords) {
    try {
        const categorizedKeywords = await categorizeKeywords(keywords);
        if (!categorizedKeywords) {
            console.warn('Could not categorize keywords, skills section unchanged');
            return $; // Return $ directly
        }

        // Dynamically find the skills section container
        // This assumes a common pattern like a heading "Skills" followed by content.
        // More robust: Use LM to find the skills container selector if needed.
        let skillsSectionContainer = null;
        $('h1, h2, h3, h4, h5, h6').each((_, el) => {
            const headingText = $(el).text().trim().toLowerCase();
            if (headingText === 'skills' || headingText === 'technical skills') {
                // Assume the content is in the next sibling div or section, or the parent's next sibling
                skillsSectionContainer = $(el).next('div, section, p');
                if (!skillsSectionContainer || skillsSectionContainer.length === 0) {
                     skillsSectionContainer = $(el).parent().next('div, section');
                }
                 if (!skillsSectionContainer || skillsSectionContainer.length === 0) {
                     skillsSectionContainer = $(el).parent(); // Fallback to parent if no clear container
                }
                return false; // Stop searching once found
            }
        });


        if (!skillsSectionContainer || skillsSectionContainer.length === 0) {
            console.warn('Skills section container not found dynamically. Cannot update skills.');
            return $; // Return $ if section not found
        }

        // Clear existing skills content within the found container? (Optional, depends on desired behavior)
        // skillsSectionContainer.empty(); // Uncomment to replace entirely

        const categoryMapping = {
            "Languages": "Languages:",
            "Frameworks/Libraries": "Frameworks/Libraries:",
            "Machine Learning Libraries": "Machine Learning Libraries:",
            "Others": "Others (Tools, Platforms, Concepts):" // Updated label slightly
        };

        // Remove existing paragraphs that match our labels to avoid duplicates if not clearing
         Object.values(categoryMapping).forEach(htmlLabel => {
             skillsSectionContainer.find(`p:contains("${htmlLabel}")`).remove();
         });


        // Append new/updated skills paragraphs
        Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
            if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                const keywordsList = categorizedKeywords[dataKey].join(', ');
                // Append new paragraph - ensures structure consistency
                skillsSectionContainer.append(`<p><strong>${htmlLabel}</strong> ${keywordsList}</p>`);
            }
        });

        return $; // Return the modified Cheerio object
    } catch (error) {
        console.error('Error updating skills section:', error);
        return $; // Return original $ on error
    }
}

// New function to identify bullet list containers using LM
async function findBulletContainersWithLM(htmlContent) {
    const prompt = `Analyze the following HTML resume content. Identify the main container elements (div, section, etc.) for each distinct "Experience" (or "Work History"), "Projects", and "Education" section. Within each of these main containers, identify the primary 'ul' or 'ol' element that holds the list of bullet points describing accomplishments or details.

Return ONLY a simple list of CSS selectors, one per line, that uniquely targets each identified bullet point list ('ul' or 'ol'). Prioritize selectors using IDs if available, then unique class combinations, or fallback to structural selectors (e.g., 'section.experience > ul'). Do NOT return JSON or explanations.

Example Output:
#experience-section > ul
.project-item .details > ul
#education > div > ul.details-list

HTML Content:
\`\`\`html
${htmlContent}
\`\`\`
`;

    try {
        const cacheKey = `find_containers_${generateHash(htmlContent)}`;
        if (lmCache.has(cacheKey)) {
            return lmCache.get(cacheKey);
        }

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano", // Or another suitable model
                messages: [
                    { role: "system", content: "You are an AI assistant that extracts CSS selectors for specific list elements from HTML." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.2,
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
        const selectors = content.split('\n').map(s => s.trim()).filter(s => s.length > 0 && (s.includes('ul') || s.includes('ol'))); // Basic validation

        if (selectors.length === 0) {
             console.warn("LM did not return any valid selectors for bullet containers.");
             return []; // Return empty array if no selectors found
        }

        lmCache.set(cacheKey, selectors);
        return selectors;

    } catch (error) {
        console.error('Error finding bullet containers with LM:', error.response?.data || error.message);
        return []; // Return empty on error
    }
}


// Updated updateResume function using dynamic identification
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);

    // 1. Dynamically find bullet list containers
    const bulletContainerSelectors = await findBulletContainersWithLM(htmlContent);
    if (bulletContainerSelectors.length === 0) {
        console.warn("No bullet containers identified. Skipping bullet updates.");
        // Still update skills and return PDF
         await updateSkillsSection($, keywords); // Update skills regardless
         return $.html(); // Return potentially modified HTML (skills only)
    }

    // 2. Update the skills section (remains largely the same)
    await updateSkillsSection($, keywords);

    // 3. Define constants (can be adjusted)
    const INITIAL_BULLET_COUNT = 5; // Default target bullets per section
    const MIN_BULLETS = 2; // Minimum bullets per section after adjustment
    const WORD_LIMIT = 15; // Default word limit for generated bullets

    const keywordString = keywords.join(', '); // Use all keywords for context

    // 4. Update each identified section
    // We don't know the 'type' (job, project, edu) from the selector alone,
    // so we use a generic context or try to infer it if needed later.
    // For now, use a generic context for bullet generation.
    for (const selector of bulletContainerSelectors) {
        await updateResumeSection(
            $,
            selector,
            keywords, // Pass full keywords list
            `related to this section`, // Generic context
            fullTailoring,
            INITIAL_BULLET_COUNT,
            WORD_LIMIT
        );
    }

    // 5. Check and adjust page length (iteratively reduce bullets)
    let currentBulletTarget = INITIAL_BULLET_COUNT;
    let attempts = 0;
    const MAX_ADJUST_ATTEMPTS = 3; // Limit adjustment loops

    while (attempts < MAX_ADJUST_ATTEMPTS && currentBulletTarget > MIN_BULLETS) {
        const currentHtml = $.html();
        const { exceedsOnePage } = await convertHtmlToPdf(currentHtml); // Check height with current state

        if (!exceedsOnePage) {
            console.log(`Resume fits on one page with ${currentBulletTarget} bullets per section.`);
            break; // Fits, no more adjustments needed
        }

        console.log(`Resume exceeds one page. Reducing target bullets from ${currentBulletTarget} to ${currentBulletTarget - 1}.`);
        currentBulletTarget--; // Reduce target count

        // Adjust bullets in all identified sections to the new target
        for (const selector of bulletContainerSelectors) {
             // Use adjustSectionBullets which handles adding/removing to meet the target
             await adjustSectionBullets(
                 $,
                 selector,
                 currentBulletTarget,
                 keywords, // Pass keywords for potential generation
                 `related to this section`, // Generic context
                 WORD_LIMIT
             );
        }
        attempts++;
    }

     if (attempts === MAX_ADJUST_ATTEMPTS && currentBulletTarget === MIN_BULLETS) {
         const { exceedsOnePage } = await convertHtmlToPdf($.html());
         if (exceedsOnePage) {
            console.warn("Resume still exceeds one page after maximum adjustments.");
         }
     }


    return $.html(); // Return the final HTML
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
        
        // Log final bullet counts for identified sections
        const $ = cheerio.load(updatedHtmlContent);
        const finalBulletCounts = {};
        const finalSelectors = await findBulletContainersWithLM(updatedHtmlContent); // Re-find selectors on final HTML
        finalSelectors.forEach((selector, index) => {
            finalBulletCounts[`Section_${index + 1}_(${selector})`] = $(selector).find('li').length;
        });
        console.log('Final bullet counts:', finalBulletCounts);

        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Final resume may exceed one page after adjustments.');
        }

        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };