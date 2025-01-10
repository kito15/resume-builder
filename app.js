const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = 3000;

const deepseekApiKey = process.env.api_key; // Replace with your actual DeepSeek API key

app.use(bodyParser.text({ type: 'text/html' }));
app.use(bodyParser.json({ limit: '50mb' }));

// Simple in-memory cache for LLM responses
const lmCache = new Map();

function getAverageBulletPointWordCount($) {
    let totalWords = 0;
    let totalBullets = 0;
    $('li').each((_, el) => {
        const text = $(el).text().trim();
        if (text) {
            totalWords += text.split(/\s+/).length;
            totalBullets++;
        }
    });
    return totalBullets === 0 ? 15 : Math.floor(totalWords / totalBullets);
}

function countWordsInBullet(text) {
    // Remove extra whitespace and special characters
    const cleaned = text.trim()
        .replace(/[""]/g, '') // Remove smart quotes
        .replace(/[.,!?()]/g, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize spaces
    
    // Count hyphenated words as one word
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

    // Count job section bullets
    $('.job-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });

    // Count project section bullets
    $('.project-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });

    // Count education section bullets
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

// Remove the old functions: generateBulletPoints, generateTailoredBulletPoints, generateAllSectionBulletPoints

async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    let prompt;
    const basePrompt = `Expert resume writer: Your task is to preserve bullet points exactly while incorporating keywords: ${keywords}

ABSOLUTE PRESERVATION RULES:
1. NEVER change:
   - Numbers (40% must stay 40%)
   - Action verbs (keep original)
   - Technical terms (keep exact)
   - Project names (keep exact)
   - Core achievements (keep exact)

2. Keywords integration:
   - ONLY add if perfect synonym match
   - ONLY add if meaning stays 100% same
   - If keyword doesn't fit, return original

FORMAT:
- Start each with '>>'
- Use ${wordLimit} words
- Return original if ANY doubt

EXAMPLES:
Original: "Developed API serving 1M requests"
+ Keyword: "architecture"
KEEP ORIGINAL (keyword doesn't fit naturally)

Original: "Led team of 5 developers"
+ Keyword: "managed"
PASS: ">>Led and managed team of 5 developers"
(only added without changing)

CRITICAL: When in doubt, return original unchanged with '>>' prefix`;

    if (mode === 'tailor') {
        prompt = `${basePrompt}

Process these bullets (prefer keeping original):
${(existingBullets || []).join('\n')}`;
    } else {
        prompt = `${basePrompt}

Generate ${context} bullets (4-5 unique, metrics-focused)`;
    }

    try {
        // Post to DeepSeek using axios
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: 'You are a professional resume writer.' },
                { role: 'user', content: prompt }
            ],
            stream: false
        }, {
            headers: {
                'Authorization': `Bearer ${deepseekApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Extract bullet points
        const content = response.data.choices[0].message.content.trim();
        const matched = content.match(/^\>\>(.+)$/gm) || [];
        return matched.map(bp =>
            bp.replace(/^>>\s*/, '')
              .replace(/\*\*/g, '')
        );
    } catch (error) {
        console.error('Error generating bullets:', error);
        throw error;
    }
}

// Modify updateResumeSection to call generateBullets in place of old functions
async function updateResumeSection($, sections, keywords, context, fullTailoring, wordLimit, usedBullets, allSectionBullets) {
    let previousFirstVerb = '';

    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        const bulletList = section.find('ul');

        if (bulletList.length > 0) {
            // Initialize bulletPoints variable
            let bulletPoints;
            
            if (fullTailoring && bulletList.find('li').length > 0) {
                // Extract existing bullets and tailor them
                const existingBullets = bulletList.find('li')
                    .map((_, el) => $(el).text())
                    .get();
                    
                bulletPoints = await generateBullets(
                    'tailor', existingBullets,
                    keywords[i % keywords.length], context, wordLimit
                );
            } else {
                // Use pre-fetched bullet points for empty sections
                bulletPoints = allSectionBullets.splice(0, 5);
                
                bulletPoints = shuffleArray(bulletPoints);

                while (bulletPoints[0].split(' ')[0].toLowerCase() === previousFirstVerb.toLowerCase()) {
                    bulletPoints = shuffleArray(bulletPoints);
                }

                previousFirstVerb = bulletPoints[0].split(' ')[0];
            }

            // Filter out duplicates
            bulletPoints = bulletPoints.filter(bp => !usedBullets.has(bp));

            // Shuffle, then ensure 4-5 total bullets
            bulletPoints = shuffleArray(bulletPoints);
            bulletPoints = await ensureBulletRange(bulletPoints, usedBullets, () =>
                generateBullets('generate', null, keywords[i % keywords.length], context, wordLimit), 4, 5);

            // Clear old items and insert final bulletPoints
            bulletList.empty();
            bulletPoints.forEach(point => {
                usedBullets.add(point);
                bulletList.append(`<li>${point}</li>`);
            });
        }
    }
}

// Remove references to generateAllSectionBulletPoints and simply fill "allSectionBullets" by calling generateBullets('generate', ...)
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const sectionWordCounts = getSectionWordCounts($);
    
    // Track used bullet points across the entire resume
    const usedBullets = new Set();

    const keywordGroups = fullTailoring ? 
        Array(5).fill(keywords.join(', ')) : // Create multiple copies for different sections
        [keywords.slice(0, Math.min(5, keywords.length)).join(', ')];

    // Single LLM call for all contexts (job, project, education)
    const allContexts = ['job experience', 'project', 'education'];
    const wordLimits = [sectionWordCounts.job, sectionWordCounts.project, sectionWordCounts.education];
    const combinedKeywords = fullTailoring
        ? Array(3).fill(keywords.join(', '))
        : [keywords.slice(0, Math.min(5, keywords.length)).join(', ')];
    const allSectionBullets = await generateBullets(
        'generate',
        null,
        fullTailoring ? keywords.join(', ') : keywords.slice(0, Math.min(5, keywords.length)).join(', '),
        'for all sections',
        15 // or use computed values if needed
    );

    // Then use 'allSectionBullets' in each 'updateResumeSection' instead of calling generateBullets again.
    await updateResumeSection($, $('.job-details'), keywordGroups, 'for a job experience', fullTailoring, sectionWordCounts.job, usedBullets, allSectionBullets);
    await updateResumeSection($, $('.project-details'), keywordGroups, 'for a project', fullTailoring, sectionWordCounts.project, usedBullets, allSectionBullets);
    await updateResumeSection($, $('.education-details'), keywordGroups, 'for education', fullTailoring, sectionWordCounts.education, usedBullets, allSectionBullets);

    return $.html();
}

async function ensureBulletRange(bulletPoints, usedBullets, generateFn, minCount, maxCount) {
    let attempts = 0;
    const originalBullets = [...bulletPoints];

    while (bulletPoints.length < minCount && attempts < 3) {
        const newPoints = (await generateFn()).filter(bp => !usedBullets.has(bp));
        bulletPoints = bulletPoints.concat(newPoints);
        attempts++;
    }

    // If still below minCount, use originals instead of placeholders
    while (bulletPoints.length < minCount) {
        const recycledBullet = originalBullets[bulletPoints.length % originalBullets.length];
        bulletPoints.push(recycledBullet || bulletPoints[0]); // Fallback to first bullet if needed
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

async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Inject custom CSS to control page layout and preserve original styles
    const customCSS = `
        @page {
            size: Letter;
            margin: 0.5in;
        }
        body {
            font-family: 'Calibri', 'Arial', sans-serif;
            font-size: 12px;
            line-height: 1.2;
            margin: 0;
            padding: 0;
            color: #333;
        }
    `;

    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);

    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true
    });

    await browser.close();
    return pdfBuffer;
}

app.post('/customize-resume', async (req, res) => {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;
        
        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }

        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);
        
        // Update resume with keywords
        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        // Convert to PDF
        const pdfBuffer = await convertHtmlToPdf(updatedHtmlContent);

        // Send response
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=customized_resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
