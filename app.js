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
    const basePrompt = `Expert resume writer: Transform bullets into compelling achievements while naturally incorporating ALL keywords.

CRITICAL REQUIREMENTS:
1) Preserve EXACT numbers, metrics, and achievements (e.g., "increased efficiency by 45%" must stay exactly as "45%")
2) Integrate ALL keywords (${keywords}) naturally into the flow
3) Maintain original actions and responsibilities
4) Each bullet starts with ">>" and uses strong action verbs
5) Keep within ${wordLimit} words unless preserving details requires more

STRUCTURE (implicit, not explicit):
- Begin with impactful action
- Weave in context naturally
- Integrate keywords smoothly
- End with quantifiable results

EXAMPLES:
Original: "Managed database optimization project"
Keywords: "Python, AWS"
✓ CORRECT: ">>Spearheaded database optimization project using Python scripts and AWS infrastructure, improving query speed by 60%"
✗ WRONG: ">>Used Python and AWS to manage databases" (lost original responsibility)
✗ WRONG: ">>Managed database project (Python, AWS)" (artificial keyword placement)

Original: "Led team of 5 developers, increased productivity 30%"
Keywords: "agile, JavaScript"
✓ CORRECT: ">>Led 5-person agile development team delivering JavaScript applications, driving 30% productivity increase"
✗ WRONG: ">>Used agile and JavaScript to increase productivity" (lost team size)

VALIDATION:
1. Verify ALL keywords appear naturally
2. Confirm ALL metrics remain unchanged
3. Ensure original achievements stay intact
4. Check for ">>" prefix`;

    if (mode === 'tailor') {
        prompt = `${basePrompt}

INPUT BULLETS TO ENHANCE (integrate ALL keywords naturally):
${(existingBullets || []).join('\n')}`;
    } else {
        prompt = `${basePrompt}

Generate 4-5 achievement-focused bullets for ${context}`;
    }

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-chat',
            messages: [
                { 
                    role: 'system', 
                    content: 'You are a specialized resume optimization AI focused on seamlessly integrating keywords while preserving achievement metrics. Your primary goal is ensuring ALL keywords appear naturally in each bullet point.'
                },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7, // Add some creativity while maintaining consistency
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
    const usedBullets = new Set();

    const keywordGroups = fullTailoring ? 
        Array(5).fill(keywords.join(', ')) : 
        [keywords.slice(0, Math.min(5, keywords.length)).join(', ')];

    const allSectionBullets = await generateBullets(
        'generate',
        null,
        fullTailoring ? keywords.join(', ') : keywords.slice(0, Math.min(5, keywords.length)).join(', '),
        'for all sections',
        15
    );

    // Initial update with maximum bullets
    await updateResumeSection($, $('.job-details'), keywordGroups, 'for a job experience', fullTailoring, sectionWordCounts.job, usedBullets, allSectionBullets);
    await updateResumeSection($, $('.project-details'), keywordGroups, 'for a project', fullTailoring, sectionWordCounts.project, usedBullets, allSectionBullets);
    await updateResumeSection($, $('.education-details'), keywordGroups, 'for education', fullTailoring, sectionWordCounts.education, usedBullets, allSectionBullets);

    // Check and adjust page length
    let currentBulletCount = 5; // Start with maximum
    let attempts = 0;
    const MIN_BULLETS = 2;

    while (attempts < 3 && currentBulletCount > MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        
        if (!exceedsOnePage) {
            break;
        }

        // Reduce bullets and try again
        currentBulletCount = await adjustBulletPoints($, 
            ['.job-details', '.project-details', '.education-details'].map(s => $(s)), 
            currentBulletCount
        );
        attempts++;
    }

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
            margin: 0.3in;
        }
        body {
            font-family: 'Calibri', 'Arial', sans-serif;
            font-size: 12px;
            line-height: 1.2;
            margin: 0;
            padding: 0;
            color: #000;
            max-width: 100%;
        }
        
        /* Header Styling */
        h1 {
            text-align: center;
            margin: 0 0 2px 0;
            font-size: 24px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #000;
        }
        
        .contact-info {
            text-align: center;
            margin-bottom: 8px;
            width: 100%;
            display: flex;
            justify-content: center;
            gap: 4px;
            align-items: center;
            color: #000;
        }
        
        /* Keep only the separator in gray */
        .contact-info > *:not(:last-child)::after {
            content: "|";
            margin-left: 4px;
            font-size: 11px;
            color: #333;
        }
        
        /* Section Styling */
        h2 {
            text-transform: uppercase;
            border-bottom: 1px solid #000;
            margin: 0 0 4px 0;
            padding: 0;
            font-size: 14px;
            font-weight: bold;
            letter-spacing: 0;
            color: #000;
        }
        
        /* Experience Section */
        .job-details, .project-details, .education-details {
            margin-bottom: 6px;
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
            gap: 4px;
            align-items: baseline;
            flex: 1;
        }
        
        .company-name {
            font-weight: bold;
            font-style: italic;
            margin-right: 4px;
        }
        
        .location {
            font-style: normal;
            margin-left: auto;
            padding-right: 4px;
        }
        
        /* Bullet Points */
        ul {
            margin: 0;
            padding-left: 12px;
            margin-bottom: 4px;
        }
        
        li {
            margin-bottom: 0;
            padding-left: 0;
            line-height: 1.25;
            text-align: justify;
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
        }
        
        /* Skills Section */
        .skills-section {
            margin-bottom: 6px;
        }
        
        .skills-section p {
            margin: 1px 0;
            line-height: 1.25;
        }
        
        /* Adjust spacing between sections */
        section {
            margin-bottom: 8px;
        }
        
        /* Project Section */
        .project-title {
            font-weight: bold;
            font-style: italic;
        }
        
        /* Education Section */
        .degree {
            font-style: italic;
        }
        
        /* Position Title */
        .position-title {
            font-style: italic;
            font-weight: normal;
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
            top: '0.3in',
            right: '0.3in',
            bottom: '0.3in',
            left: '0.3in'
        }
    });

    await browser.close();
    return { pdfBuffer, exceedsOnePage: height > MAX_HEIGHT };
}

// Add new function to manage bullet points
async function adjustBulletPoints($, sections, currentBulletCount) {
    // Reduce bullets in all sections equally
    sections.forEach(section => {
        const bulletList = $(section).find('ul');
        const bullets = bulletList.find('li');
        if (bullets.length > currentBulletCount) {
            // Remove the last bullet
            bullets.last().remove();
        }
    });
    return currentBulletCount - 1;
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
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }

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
