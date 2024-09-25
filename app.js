const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = 3000;

const openaiApiKey = process.env.api_key; // Replace with your actual OpenAI API key

app.use(bodyParser.text({ type: 'text/html' }));

async function generateBulletPoints(keywords, context) {
    const prompt = `As an expert resume writer, your task is to create bullet points for a resume ${context}, with each bullet point limited to 15 words or less. Create enough bullet points to incorporate all provided keywords, with a maximum of five bullet points. It is crucial that ALL provided keywords are incorporated into the bullet points. Do not omit any keywords.

Before we proceed, let's ensure we're on the same page:
- What does it mean for a bullet point to be concise and not exceed 15 words?
- What are personal pronouns and why should they be avoided in this context?
- Can you provide an example of a strong action verb?

The bullet points should be tailored to the following keywords: ${keywords}.

For at least two of the bullet points, include numbers to quantify achievements. Despite limited experience, aim to make your bullet points impressive. Can you provide an example of how to do this?

You are also asked to structure the resume based on the STAR method. Can you explain what the STAR method is and how it provides a clear and engaging narrative of accomplishments?

Ensure that all keywords are incorporated in the bullet points and that they are relevant to the job role and industry. Prioritize the inclusion of all keywords over other considerations, while still maintaining coherence and relevance within the 15-word limit. Remember to apply the STAR method to your bullet points where possible.

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
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a professional resume writer.' },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const content = response.data.choices[0].message.content.trim();
        const bulletPoints = content.match(/^\>\>(.+)$/gm).map(bp => bp.replace(/^>>\s*/, ''));
        return bulletPoints;
    } catch (error) {
        console.error('Error generating bullet points:', error);
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

async function updateResumeSection(sections, keywords, context) {
    let previousFirstVerb = '';

    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        const bulletList = section.find('ul');

        if (bulletList.length > 0 && bulletList.find('li').length === 0) {
            let bulletPoints = await generateBulletPoints(keywords[i % keywords.length], context);
            
            bulletPoints = shuffleArray(bulletPoints);

            while (bulletPoints[0].split(' ')[0].toLowerCase() === previousFirstVerb.toLowerCase()) {
                bulletPoints = shuffleArray(bulletPoints);
            }

            previousFirstVerb = bulletPoints[0].split(' ')[0];

            bulletPoints.forEach(point => {
                bulletList.append(`<li>${point}</li>`);
            });
        }
    }
}

async function updateResume(htmlContent) {
    const $ = cheerio.load(htmlContent);

    const jobKeywords = [
        'JavaScript, React, Node.js',
        'Python, Django, Flask',
        'Java, Spring Boot, Hibernate',
        'C++, Qt, Boost',
        'Ruby, Rails, Sinatra'
    ];

    await updateResumeSection($('.job-details'), jobKeywords, 'for a job experience');
    await updateResumeSection($('.project-details'), jobKeywords, 'for a project');

    return $.html();
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
            font-size: 11px;
            line-height: 1.1;
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
        preferCSSPageSize: true,
        margin: {
            top: '0.5in',
            right: '0.5in',
            bottom: '0.5in',
            left: '0.5in'
        }
    });

    await browser.close();
    return pdfBuffer;
}

app.post('/customize-resume', async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'string') {
            return res.status(400).send('Invalid input: HTML content is required');
        }

        console.log('Received HTML content');
        const htmlContent = req.body;
        
        console.log('Updating resume');
        const updatedHtmlContent = await updateResume(htmlContent);
        
        console.log('Converting to PDF');
        const pdfBuffer = await convertHtmlToPdf(updatedHtmlContent);

        console.log('Sending PDF response');
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=customized_resume.pdf');
        res.send(Buffer.from(pdfBuffer));
    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('An error occurred while processing the resume: ' + error.message);
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
