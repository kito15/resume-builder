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

function normalizeText(text) {
    return text.trim()
        .replace(/\s+/g, ' ')  // normalize spaces
        .replace(/[.,;:]/g, '') // remove punctuation
        .trim();
}

function getWordCount(text) {
    return normalizeText(text).split(' ').length;
}

function getSectionStatistics($, selector) {
    const stats = {
        minWords: Infinity,
        maxWords: 0,
        avgWords: 0,
        totalWords: 0,
        bulletCount: 0
    };

    $(selector).find('li').each((_, el) => {
        const wordCount = getWordCount($(el).text());
        stats.minWords = Math.min(stats.minWords, wordCount);
        stats.maxWords = Math.max(stats.maxWords, wordCount);
        stats.totalWords += wordCount;
        stats.bulletCount++;
    });

    if (stats.bulletCount > 0) {
        stats.avgWords = Math.round(stats.totalWords / stats.bulletCount);
    } else {
        // Default values if no bullets exist
        stats.minWords = 15;
        stats.maxWords = 30;
        stats.avgWords = 20;
    }

    return stats;
}

async function generateBulletPoints(keywords, context, stats) {
    const prompt = `As an expert resume writer, your task is to create bullet points ${context}, ` +
        `with each bullet point limited to ${stats.avgWords} words or less. Create enough bullet points ` +
        `to incorporate all provided keywords, with a maximum of five bullet points. It is crucial that ALL provided keywords are incorporated into the bullet points. Do not omit any keywords.

Before we proceed, let's ensure we're on the same page:
- What does it mean for a bullet point to be concise and not exceed ${stats.avgWords} words?
- What are personal pronouns and why should they be avoided in this context?
- Can you provide an example of a strong action verb?

The bullet points should be tailored to the following keywords: ${keywords}.

For at least two of the bullet points, include numbers to quantify achievements. Despite limited experience, aim to make your bullet points impressive. Can you provide an example of how to do this?

You are also asked to structure the resume based on the STAR method. Can you explain what the STAR method is and how it provides a clear and engaging narrative of accomplishments?

Ensure that all keywords are incorporated in the bullet points and that they are relevant to the job role and industry. Prioritize the inclusion of all keywords over other considerations, while still maintaining coherence and relevance within the ${stats.avgWords}-word limit. Remember to apply the STAR method to your bullet points where possible.

After generating the bullet points, provide a checklist of all keywords and indicate which bullet point(s) each keyword appears in.

Please format your response as follows:
1. Provide any explanations or additional information.
2. List the bullet points, each on a new line, prefixed with '>>'.
3. After the bullet points, provide a checklist of all keywords and indicate which bullet point(s) each keyword appears in.

Example format:
[Any explanations or additional information]

>>First bullet point here
>>Second bullet point here
>>Third bullet point here

Keyword checklist:
- Keyword1: Appears in bullet points 1, 3
- Keyword2: Appears in bullet point 2`;

    try {
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

        const content = response.data.choices[0].message.content.trim();
        const matched = content.match(/^\>\>(.+)$/gm) || [];
        return matched.map(bp => bp.replace(/^>>\s*/, ''));
    } catch (error) {
        console.error('Error generating bullet points:', error);
        throw error;
    }
}

async function generateTailoredBulletPoints(existingBullets, keywords, context, wordLimit) {
    const prompt = `As an expert resume writer, enhance the following bullet points by incorporating these keywords: ${keywords} ` +
        `while maintaining their original meaning. Each bullet point must: ` +
        `- Be prefixed with '>>'. ` +
        `- Contain no more than ${wordLimit} words. ` +
        `- Preserve the core meaning with minimal changes. ` +
        `- Incorporate keywords naturally. ` +
        `- Follow the STAR method where applicable. ` +
        `Do not exceed ${wordLimit} words per bullet.`;

    try {
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

        const content = response.data.choices[0].message.content.trim();
        const matched = content.match(/^\>\>(.+)$/gm) || [];
        return matched.map(bp => bp.replace(/^>>\s*/, ''));
    } catch (error) {
        console.error('Error generating tailored bullet points:', error);
        throw error;
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function updateResumeSection($, sections, keywords, context, fullTailoring, stats, usedBullets) {
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
                    
                bulletPoints = await generateTailoredBulletPoints(
                    existingBullets,
                    keywords[i % keywords.length],
                    context,
                    stats.avgWords
                );
            } else {
                // Generate new bullet points for empty sections
                bulletPoints = await generateBulletPoints(
                    keywords[i % keywords.length], 
                    context, 
                    stats
                );
                
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
                generateBulletPoints(keywords[i % keywords.length], context, stats), 4, 5);

            // Validate and possibly regenerate bullets that don't meet length requirements
            bulletPoints = await Promise.all(bulletPoints.map(async (point) => {
                let attempts = 0;
                while (!await validateBulletLength(point, stats) && attempts < 3) {
                    const newPoints = await generateBulletPoints(keywords[i % keywords.length], context, stats);
                    point = newPoints[0];
                    attempts++;
                }
                return point;
            }));

            // Clear old items and insert final bulletPoints
            bulletList.empty();
            bulletPoints.forEach(point => {
                usedBullets.add(point);
                bulletList.append(`<li>${point}</li>`);
            });
        }
    }
}

async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const usedBullets = new Set();

    // Get statistics for each section
    const jobStats = getSectionStatistics($, '.job-details');
    const projectStats = getSectionStatistics($, '.project-details');
    const educationStats = getSectionStatistics($, '.education-details');

    const keywordGroups = fullTailoring ? 
        Array(5).fill(keywords.join(', ')) : // Create multiple copies for different sections
        [keywords.slice(0, Math.min(5, keywords.length)).join(', ')];

    // Pass section-specific word counts
    await updateResumeSection($, $('.job-details'), keywordGroups, 'for a job experience', 
        fullTailoring, jobStats, usedBullets);
    await updateResumeSection($, $('.project-details'), keywordGroups, 'for a project', 
        fullTailoring, projectStats, usedBullets);
    await updateResumeSection($, $('.education-details'), keywordGroups, 'for education', 
        fullTailoring, educationStats, usedBullets);

    return $.html();
}

async function ensureBulletRange(bulletPoints, usedBullets, generateFn, minCount, maxCount) {
    // Keep trying to generate more if needed, up to a few attempts
    let attempts = 0;
    while (bulletPoints.length < minCount && attempts < 3) {
        const newPoints = (await generateFn()).filter(bp => !usedBullets.has(bp));
        bulletPoints = bulletPoints.concat(newPoints);
        attempts++;
    }
    // Fill placeholders if still below minCount
    while (bulletPoints.length < minCount) {
        bulletPoints.push(`Placeholder bullet point ${bulletPoints.length + 1}`);
    }
    // Truncate if above maxCount
    if (bulletPoints.length > maxCount) {
        bulletPoints = bulletPoints.slice(0, maxCount);
    }
    return bulletPoints;
}

async function validateBulletLength(bullet, stats) {
    const wordCount = getWordCount(bullet);
    return wordCount >= stats.minWords * 0.8 && wordCount <= stats.maxWords * 1.2;
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
