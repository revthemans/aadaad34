
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const axios = require('axios');
const express = require('express');
const { Client } = require('discord.js-selfbot-v13');

// Configuration - Railway deployment ready
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const USERNAME_WEBHOOK_URL = process.env.USERNAME_WEBHOOK_URL;
const ITEM_IDS = process.env.ITEM_IDS || '439946249,180660043,1016143686,98346834,1191135761,250395631,416846000,398676450,42211680'; // Comma-separated item IDs
const YOUR_ADMIN_KEY = process.env.YOUR_ADMIN_KEY;
const YOUR_API_URL = process.env.YOUR_API_URL || 'http://localhost:4000/lookup/roblox';

// Discord API configuration (for reading back messages)
const USER_TOKEN = process.env.USER_TOKEN;
const GUILD_ID = process.env.GUILD_ID || '1423783454297817162';
const COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID || '1462274235958562827'; // Channel where commands are sent
const MONITOR_CHANNEL_ID = process.env.MONITOR_CHANNEL_ID || '1462245649834577952'; // Channel where webhook messages with usernames are sent

// Express server for healthcheck
const app = express();
const PORT = process.env.PORT || 3000;

let driver; // Global Selenium WebDriver instance
let profileDriver; // Dedicated driver for profile scraping
let processedUsers = new Set();
let totalLogged = 0;
let isScraping = false;
let retryCount = 0;
const MAX_RETRIES = 3;

// Healthcheck endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'healthy', 
        scraping: isScraping,
        totalLogged: totalLogged,
        timestamp: new Date().toISOString()
    });
});

// Start Express server
app.listen(PORT, () => {
    console.log(`🌐 Healthcheck server running on port ${PORT}`);
});

// Initialize Discord client (if token is provided)
let discordClient = null;
if (USER_TOKEN) {
    discordClient = new Client({
        checkUpdate: false
    });

    discordClient.on('ready', () => {
        console.log(`✅ Discord bot logged in as ${discordClient.user.tag}`);
        console.log(`👀 Accepting commands from channel ${COMMAND_CHANNEL_ID}`);
        console.log(`📥 Reading usernames from channel ${MONITOR_CHANNEL_ID}`);
    });

    discordClient.on('messageCreate', async (message) => {
        // Only listen to commands from the command channel
        if (message.channel.id !== COMMAND_CHANNEL_ID) {
            return;
        }
        
        // Only respond to commands starting with !
        if (!message.content.startsWith('!')) {
            return;
        }
        
        const command = message.content.trim();
        
        // Command: !total
        if (command === '!total') {
            console.log('📊 Processing !total command...');
            await message.reply('🔄 Fetching all usernames from channel history... This may take a moment.');
            
            try {
                const usernames = await fetchAllMessages(MONITOR_CHANNEL_ID);
                const count = usernames.length;
                
                if (count === 0) {
                    await message.reply('❌ No Discord usernames found in channel history.');
                } else {
                    // Discord message content limit is 2000 chars. Sending 300+ usernames in one message
                    // easily exceeds that. Only send the count; use !makefiletotal for the full list.
                    await message.reply(`✅ Found **${count}** unique Discord username(s) in channel history.\n\nUse \`!makefiletotal\` to export the full list to a file.`);
                }
            } catch (error) {
                console.error('❌ Error processing !total:', error.message);
                await message.reply(`❌ Error: ${error.message}`);
            }
        }
        
        // Command: !totalfrom (username) to (username)
        else if (command.startsWith('!totalfrom')) {
            console.log('📊 Processing !totalfrom command...');
            const match = command.match(/^!totalfrom\s+(.+?)\s+to\s+(.+)$/);
            
            if (!match) {
                await message.reply('❌ Invalid format. Use: `!totalfrom <username> to <username>`');
                return;
            }
            
            const startUsername = match[1].trim();
            const endUsername = match[2].trim();
            
            await message.reply(`🔄 Searching for messages between "${startUsername}" and "${endUsername}"...`);
            
            try {
                const startMessageId = await findMessageIdByUsername(MONITOR_CHANNEL_ID, startUsername);
                const endMessageId = await findMessageIdByUsername(MONITOR_CHANNEL_ID, endUsername);
                
                if (!startMessageId) {
                    await message.reply(`❌ Could not find message with username: ${startUsername}`);
                    return;
                }
                
                if (!endMessageId) {
                    await message.reply(`❌ Could not find message with username: ${endUsername}`);
                    return;
                }
                
                const usernames = await fetchAllMessages(MONITOR_CHANNEL_ID, startMessageId, endMessageId);
                const count = usernames.length;
                
                if (count === 0) {
                    await message.reply('❌ No Discord usernames found between the specified messages.');
                } else {
                    // Avoid 2000-char limit: only send count; use !makefile for the full list.
                    await message.reply(`✅ Found **${count}** unique Discord username(s) between messages.\n\nUse \`!makefile ${startUsername} to ${endUsername}\` to export the full list to a file.`);
                }
            } catch (error) {
                console.error('❌ Error processing !totalfrom:', error.message);
                await message.reply(`❌ Error: ${error.message}`);
            }
        }
        
        // Command: !makefiletotal
        else if (command === '!makefiletotal') {
            console.log('📝 Processing !makefiletotal command...');
            await message.reply('🔄 Creating file with all usernames... This may take a moment.');
            
            try {
                const usernames = await fetchAllMessages(MONITOR_CHANNEL_ID);
                const count = usernames.length;
                
                if (count === 0) {
                    await message.reply('❌ No Discord usernames found. File not created.');
                    return;
                }
                
                const filename = `discord_usernames_total_${Date.now()}.txt`;
                const content = usernames.join('\n');
                
                // Reply to the user who ran the command with the .txt file attached (no server disk write)
                await message.reply({
                    content: `✅ **${filename}**\n📊 Contains **${count}** Discord username(s).\n📎 File attached below.`,
                    files: [{ attachment: Buffer.from(content, 'utf8'), name: filename }]
                });
            } catch (error) {
                console.error('❌ Error processing !makefiletotal:', error.message);
                await message.reply(`❌ Error: ${error.message}`);
            }
        }
        
        // Command: !makefile (username) to (username)
        else if (command.startsWith('!makefile')) {
            console.log('📝 Processing !makefile command...');
            const match = command.match(/^!makefile\s+(.+?)\s+to\s+(.+)$/);
            
            if (!match) {
                await message.reply('❌ Invalid format. Use: `!makefile <username> to <username>`');
                return;
            }
            
            const startUsername = match[1].trim();
            const endUsername = match[2].trim();
            
            await message.reply(`🔄 Creating file with usernames between "${startUsername}" and "${endUsername}"...`);
            
            try {
                const startMessageId = await findMessageIdByUsername(MONITOR_CHANNEL_ID, startUsername);
                const endMessageId = await findMessageIdByUsername(MONITOR_CHANNEL_ID, endUsername);
                
                if (!startMessageId) {
                    await message.reply(`❌ Could not find message with username: ${startUsername}`);
                    return;
                }
                
                if (!endMessageId) {
                    await message.reply(`❌ Could not find message with username: ${endUsername}`);
                    return;
                }
                
                const usernames = await fetchAllMessages(MONITOR_CHANNEL_ID, startMessageId, endMessageId);
                const count = usernames.length;
                
                if (count === 0) {
                    await message.reply('❌ No Discord usernames found. File not created.');
                    return;
                }
                
                const filename = `discord_usernames_${startUsername}_to_${endUsername}_${Date.now()}.txt`;
                const content = usernames.join('\n');
                
                // Reply to the user who ran the command with the .txt file attached (no server disk write)
                await message.reply({
                    content: `✅ **${filename}**\n📊 Contains **${count}** Discord username(s).\n📎 File attached below.`,
                    files: [{ attachment: Buffer.from(content, 'utf8'), name: filename }]
                });
            } catch (error) {
                console.error('❌ Error processing !makefile:', error.message);
                await message.reply(`❌ Error: ${error.message}`);
            }
        }
    });

    discordClient.on('error', (e) => console.error('❌ Discord client error:', e));
} else {
    console.log('ℹ️ USER_TOKEN not set. Discord bot functionality disabled.');
    console.log('💡 Set USER_TOKEN environment variable to enable Discord command features.');
}

// Extract Discord username from webhook embed or plain text message
function extractDiscordUsername(message) {
    // Check if message is from a webhook
    if (message.webhookId) {
        // Method 1: Check for embed with "Discord Username" field
        if (message.embeds && message.embeds.length > 0) {
            for (const embed of message.embeds) {
                if (embed.fields) {
                    for (const field of embed.fields) {
                        if (field.name === 'Discord Username' && field.value) {
                            return field.value.trim();
                        }
                    }
                }
            }
        }
        
        // Method 2: Check plain text content (for username-only webhook)
        if (message.content && message.content.trim()) {
            // Check if it's just a username (no spaces, typically Discord format)
            const content = message.content.trim();
            if (!content.includes(' ') && content.length > 0) {
                return content;
            }
        }
    }
    
    return null;
}

// Fetch all messages from channel using Discord API
async function fetchAllMessages(channelId, startMessageId = null, endMessageId = null) {
    const usernames = [];
    let lastMessageId = startMessageId || null;
    let foundStartMessage = !startMessageId;
    let foundEndMessage = false;
    const botToken = USER_TOKEN; // Using user token for API calls
    
    if (!botToken) {
        console.error('❌ USER_TOKEN not set, cannot fetch messages from Discord API');
        return [];
    }
    
    console.log('📥 Fetching messages from Discord API...');
    
    while (true) {
        try {
            const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
            const params = { limit: 100 };
            if (lastMessageId) {
                params.before = lastMessageId;
            }
            
            const response = await axios.get(url, {
                headers: {
                    'Authorization': botToken,
                    'Content-Type': 'application/json'
                },
                params: params
            });
            
            const messages = response.data;
            
            if (!messages || messages.length === 0) {
                break;
            }
            
            for (const msg of messages) {
                // Check if we've reached the end message
                if (endMessageId && msg.id === endMessageId) {
                    foundEndMessage = true;
                    break;
                }
                
                // If we have a start message ID, skip until we find it
                if (startMessageId && !foundStartMessage) {
                    if (msg.id === startMessageId) {
                        foundStartMessage = true;
                    } else {
                        continue;
                    }
                }
                
                // Extract username from message
                if (foundStartMessage && !foundEndMessage) {
                    // Check webhook messages
                    if (msg.webhook_id) {
                        // Check embeds
                        if (msg.embeds && msg.embeds.length > 0) {
                            for (const embed of msg.embeds) {
                                if (embed.fields) {
                                    for (const field of embed.fields) {
                                        if (field.name === 'Discord Username' && field.value) {
                                            const username = field.value.trim();
                                            if (username && !usernames.includes(username)) {
                                                usernames.push(username);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Check plain content
                        if (msg.content && msg.content.trim()) {
                            const content = msg.content.trim();
                            if (!content.includes(' ') && content.length > 0) {
                                if (!usernames.includes(content)) {
                                    usernames.push(content);
                                }
                            }
                        }
                    }
                }
                
                // Set last message ID for pagination
                lastMessageId = msg.id;
            }
            
            // If we found the end message, stop
            if (foundEndMessage) {
                break;
            }
            
            // If we got fewer than 100 messages, we've reached the end
            if (messages.length < 100) {
                break;
            }
            
            // Rate limit: wait a bit between requests
            await new Promise(resolve => setTimeout(resolve, 500));
            
        } catch (error) {
            console.error('❌ Error fetching messages:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
            break;
        }
    }
    
    return usernames.reverse(); // Return in chronological order
}

// Find message ID by username in message content
async function findMessageIdByUsername(channelId, username) {
    const botToken = USER_TOKEN;
    
    if (!botToken) {
        console.error('❌ USER_TOKEN not set, cannot search for messages');
        return null;
    }
    
    let lastMessageId = null;
    
    console.log(`🔍 Searching for message with username: ${username}`);
    
    while (true) {
        try {
            const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
            const params = { limit: 100 };
            if (lastMessageId) {
                params.before = lastMessageId;
            }
            
            const response = await axios.get(url, {
                headers: {
                    'Authorization': botToken,
                    'Content-Type': 'application/json'
                },
                params: params
            });
            
            const messages = response.data;
            
            if (!messages || messages.length === 0) {
                break;
            }
            
            for (const msg of messages) {
                // Check if message contains the username
                if (msg.webhook_id) {
                    // Check embeds
                    if (msg.embeds && msg.embeds.length > 0) {
                        for (const embed of msg.embeds) {
                            if (embed.fields) {
                                for (const field of embed.fields) {
                                    if (field.name === 'Discord Username' && field.value && field.value.trim() === username) {
                                        return msg.id;
                                    }
                                }
                            }
                        }
                    }
                    
                    // Check plain content
                    if (msg.content && msg.content.trim() === username) {
                        return msg.id;
                    }
                }
                
                lastMessageId = msg.id;
            }
            
            if (messages.length < 100) {
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
            
        } catch (error) {
            console.error('❌ Error searching for message:', error.message);
            break;
        }
    }
    
    return null;
}

async function startScraper() {
    console.log('🔐 Initializing scraper...');
    const initialized = await initializeWebDriver();
    if (!initialized) {
        console.error('❌ Failed to initialize WebDriver, exiting.');
        process.exit(1);
    }

    // Always start scraping with ITEM_IDS from environment
    console.log('🚀 Starting Rolimons scraper...');
    isScraping = true;
    const itemIds = ITEM_IDS.split(',').map(id => id.trim()).filter(id => id && !isNaN(id));
    if (itemIds.length > 0) {
        console.log('⚙️ Starting scrape for items:', itemIds.join(', '));
        for (const itemId of itemIds) {
            await scrapeRolimonsItem(itemId);
        }
        console.log("✅ All items scraped, script finished.");
        isScraping = false;
    } else {
        console.log('❌ No valid item IDs found in environment variables');
        process.exit(1);
    }
}

async function initializeWebDriver() {
    try {
        console.log('🔧 Initializing Selenium WebDriver...');

        const options = new chrome.Options();
        options.addArguments('--headless');
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-gpu');
        options.addArguments('--window-size=1920,1080');
        options.addArguments('--disable-web-security');
        options.addArguments('--disable-features=VizDisplayCompositor');
        options.addArguments('--disable-extensions');
        options.addArguments('--disable-plugins');
        options.addArguments('--disable-images');
        options.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        options.addArguments('--disable-blink-features=AutomationControlled');
        options.addArguments('--exclude-switches=enable-automation');

        driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();

        // Initialize profile driver with different settings
        const profileOptions = new chrome.Options();
        profileOptions.addArguments('--headless');
        profileOptions.addArguments('--no-sandbox');
        profileOptions.addArguments('--disable-dev-shm-usage');
        profileOptions.addArguments('--disable-gpu');
        profileOptions.addArguments('--window-size=1920,1080');
        profileOptions.addArguments('--disable-web-security');
        profileOptions.addArguments('--disable-features=VizDisplayCompositor');
        profileOptions.addArguments('--disable-extensions');
        profileOptions.addArguments('--disable-plugins');
        profileOptions.addArguments('--disable-images');
        profileOptions.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        profileOptions.addArguments('--disable-blink-features=AutomationControlled');
        profileOptions.addArguments('--exclude-switches=enable-automation');

        profileDriver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(profileOptions)
            .build();

        console.log('✅ Selenium WebDriver initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ WebDriver initialization error:', error.message);
        return false;
    }
}

async function scrapeRolimonsItem(itemId) {
    try {
        const url = `https://www.rolimons.com/item/${itemId}`;
        console.log(`🔍 Getting item information from ${url}`);
        
        // Navigate to the first page to get item name and find pagination
        await driver.get(url);
        await driver.sleep(5000);

        // Scroll to top to avoid ad overlays
        await driver.executeScript('window.scrollTo(0, 0);');
        await driver.sleep(1000);
        
        // Click "All Copies" tab to get all users instead of just premium copies
        try {
            console.log('📋 Clicking "All Copies" tab...');
            
            // Try multiple methods to click the tab
            let tabClicked = false;
            const allCopiesTab = await driver.findElement(By.css('a[href="#all_copies_table_container"]'));
            const className = await allCopiesTab.getAttribute('class');
            
            if (!className.includes('active')) {
                // Method 1: Try JavaScript click (bypasses overlays)
                try {
                    await driver.executeScript('arguments[0].click();', allCopiesTab);
                    console.log('✅ Successfully clicked "All Copies" tab (JS click)');
                    tabClicked = true;
                } catch (e1) {
                    console.log('⚠️ JS click failed, trying scroll then click...');
                    // Method 2: Scroll element into view first
                    try {
                        await driver.executeScript('arguments[0].scrollIntoView({behavior: "smooth", block: "center"});', allCopiesTab);
                        await driver.sleep(1000);
                        await allCopiesTab.click();
                        console.log('✅ Successfully clicked "All Copies" tab (scroll + click)');
                        tabClicked = true;
                    } catch (e2) {
                        console.log('⚠️ Scroll click failed, trying force JS click...');
                        // Method 3: Force JavaScript click with event
                        try {
                            await driver.executeScript(`
                                var element = arguments[0];
                                element.style.zIndex = '9999';
                                element.click();
                            `, allCopiesTab);
                            console.log('✅ Successfully clicked "All Copies" tab (force JS)');
                            tabClicked = true;
                        } catch (e3) {
                            console.log('⚠️ All click methods failed, attempting to wait and retry...');
                            // Wait a bit for ads to potentially disappear
                            await driver.sleep(3000);
                            await driver.executeScript('arguments[0].click();', allCopiesTab);
                            tabClicked = true;
                        }
                    }
                }
            } else {
                console.log('✅ "All Copies" tab already active');
                tabClicked = true;
            }
            
            if (tabClicked) {
                // Wait for tab switch
                await driver.sleep(2000);
                
                // CRITICAL: Wait for the All Copies table to actually load and be ready
                console.log('⏳ Waiting for All Copies table to load...');
                try {
                    await driver.wait(until.elementLocated(By.css('#all_copies_table tbody tr')), 20000);
                    await driver.sleep(3000); // Extra wait for DataTables to fully initialize
                    
                    // Verify we're on the All Copies tab by checking the table exists
                    const rows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                    console.log(`✅ All Copies table loaded with ${rows.length} rows visible`);
                } catch (tableError) {
                    console.log('⚠️ Table not found yet, trying to refresh tab click...');
                    // Retry clicking if table didn't load
                    try {
                        await driver.executeScript('arguments[0].click();', allCopiesTab);
                        await driver.sleep(3000);
                        await driver.wait(until.elementLocated(By.css('#all_copies_table tbody tr')), 20000);
                        const rows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                        console.log(`✅ All Copies table loaded after retry with ${rows.length} rows visible`);
                    } catch (retryError) {
                        console.log('⚠️ Table still not found after retry:', retryError.message);
                        throw new Error('Failed to load All Copies table after multiple attempts');
                    }
                }
            }
        } catch (e) {
            console.log('⚠️ Could not find/click "All Copies" tab or table not ready:', e.message);
            // Try one more time with a different approach
            try {
                console.log('🔄 Attempting final retry to load All Copies table...');
                await driver.sleep(3000);
                const finalTab = await driver.findElement(By.css('a[href="#all_copies_table_container"]'));
                await driver.executeScript('arguments[0].click();', finalTab);
                await driver.sleep(5000);
                await driver.wait(until.elementLocated(By.css('#all_copies_table')), 15000);
                console.log('✅ All Copies table found on final retry');
            } catch (finalError) {
                console.log('❌ Could not load All Copies table after all attempts:', finalError.message);
                throw finalError;
            }
        }

        // Extract item name from page title (for logging only)
        let itemName = 'Unknown Item';
        try {
            const titleElement = await driver.findElement(By.css('h1.page_title.mb-0'));
            itemName = await titleElement.getText();
            console.log(`📦 Scraping ${itemName}`);
        } catch (e) {
            console.log('⚠️ Could not extract item name, using default');
        }

        // Wait a bit more for the table to fully initialize
        await driver.sleep(2000);
        
        // Verify table exists before trying to find pagination
        try {
            await driver.wait(until.elementLocated(By.css('#all_copies_table')), 15000);
            console.log('✅ All Copies table container found');
        } catch (e) {
            console.log('❌ All Copies table container not found, cannot proceed');
            throw new Error('All Copies table failed to load');
        }
        
        let totalPages = 1;
        
        try {
            // Find the pagination container and detect the highest visible page number.
            // Match the exact logic from test-pagination.js that works correctly
            console.log('🔍 Looking for pagination...');
            await driver.wait(until.elementLocated(By.css('#all_copies_table_paginate')), 15000);

            const pageButtons = await driver.findElements(By.css('#all_copies_table_paginate a.page-link[data-dt-idx]'));
            let lastPageButton = null;

            for (const button of pageButtons) {
                const text = (await button.getText()).trim();
                if (/^\d+$/.test(text)) {
                    const pageNum = parseInt(text, 10);
                    if (!isNaN(pageNum) && pageNum > totalPages) {
                        totalPages = pageNum;
                        lastPageButton = button;
                    }
                }
            }

            if (lastPageButton && totalPages > 1) {
                console.log(`📄 Highest page number found: ${totalPages}. Clicking it to go to last page...`);
                // Match test-pagination.js: try regular click first, fallback to JS click
                try {
                    await lastPageButton.click();
                    console.log('✅ Regular click succeeded');
                } catch (e) {
                    console.log(`⚠️ Regular click failed: ${e.message}, trying JS click...`);
                    await driver.executeScript('arguments[0].click();', lastPageButton);
                    console.log('✅ JS click succeeded');
                }
                // Wait for DataTables to finish updating the table (same as test)
                await driver.sleep(5000);
            } else {
                console.log('⚠️ Could not find a numeric last page button, assuming single page');
            }
        } catch (e) {
            console.log('⚠️ Error finding pagination:', e.message);
        }

        console.log(`🔄 Starting continuous scraping from page ${totalPages} (last page) going backwards using Prev...`);

        for (let page = totalPages; page >= 1; page--) {
            console.log(`\n📄 Processing page ${page}/${totalPages}`);
            if (page !== totalPages) {
                // Click the Prev button (data-dt-idx="0") to go back one page at a time
                try {
                    const prevLink = await driver.findElement(By.css('#all_copies_table_paginate a.page-link[data-dt-idx="0"]'));
                    const prevParent = await prevLink.findElement(By.xpath('..'));
                    const cls = ((await prevParent.getAttribute('class')) || '').toLowerCase();

                    if (cls.includes('disabled')) {
                        console.log('⏹️ Prev button is disabled; reached the first page.');
                        break;
                    }

                    console.log('⬅️ Clicking Prev to move to previous page...');
                    // Match test-pagination.js: try regular click first, fallback to JS click
                    try {
                        await prevLink.click();
                        console.log('✅ Prev regular click succeeded');
                    } catch (e) {
                        console.log(`⚠️ Prev regular click failed: ${e.message}, trying JS click...`);
                        await driver.executeScript('arguments[0].click();', prevLink);
                        console.log('✅ Prev JS click succeeded');
                    }
                    await driver.sleep(5000); // Wait for table to update (same as test)
                } catch (e) {
                    console.log(`❌ Could not click Prev for page ${page}: ${e.message}`);
                    break;
                }
            }
            // No extra sleep here - we already waited after the click, match test-pagination.js behavior

            // ALWAYS log the DataTables "Showing X to Y of Z entries" info so we can
            // confirm which slice of the owner list this page actually represents.
            let infoText = '';
            try {
                infoText = await driver.findElement(By.css('#all_copies_table_info')).getText();
                console.log(`📊 DataTables info for current page: "${infoText}"`);
            } catch (e) {
                console.log('⚠️ Could not read all_copies_table_info:', e.message);
            }
            
            // CRITICAL: Verify we're reading from the correct table by checking a sample username
            // before processing all rows. This helps catch if we're reading stale/cached data.
            try {
                const sampleRows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                if (sampleRows.length > 0) {
                    const firstRow = sampleRows[0];
                    const sampleLink = await firstRow.findElement(By.css('a[href*="/player/"]'));
                    const sampleUsername = await sampleLink.getText();
                    console.log(`🔍 Sample user on this page (first row): "${sampleUsername}"`);
                }
            } catch (e) {
                console.log('⚠️ Could not read sample user from table:', e.message);
            }

            // Use EXACT same selector as test-pagination.js that works correctly
            let rows = [];
            try {
                await driver.wait(until.elementLocated(By.css('#all_copies_table tbody tr')), 15000);
                rows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                console.log(`✅ Found ${rows.length} rows with selector: #all_copies_table tbody tr`);
            } catch (e) {
                console.log(`❌ Could not find rows: ${e.message}`);
                continue;
            }
            
            if (rows.length === 0) {
                console.log(`❌ No users found on page ${page}, skipping...`);
                continue;
            }
            console.log(`👥 Found ${rows.length} users on page ${page}`);
            console.log(`🔄 Processing users from bottom to top (reverse order)...`);

            for (let i = rows.length - 1; i >= 0; i--) {
                try {
                    // Use ONLY the specific selector - don't use broad selectors that might match other tables
                    const currentRows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                    if (i >= currentRows.length) {
                        console.log(`⏭️ Row ${i} no longer exists, skipping...`);
                        continue;
                    }
                    const row = currentRows[i];

                    // Always use the Rolimons profile link (e.g. <a href="/player/1">Roblox</a>)
                    const link = await row.findElement(By.css('a[href*="/player/"]'));

                    // Try multiple ways to get the visible username text
                    let username = (await link.getText()) || '';
                    username = username.trim();

                    if (!username) {
                        // Fallback: use textContent attribute
                        try {
                            username = ((await link.getAttribute('textContent')) || '').trim();
                        } catch (_) {
                            // ignore
                        }
                    }

                    // Build absolute Rolimons profile URL from href
                    let profileUrl = (await link.getAttribute('href')) || '';
                    if (profileUrl && !profileUrl.startsWith('http')) {
                        profileUrl = `https://www.rolimons.com${profileUrl}`;
                    }

                    if (!username) {
                        console.log(`⚠️ Username text empty for row ${i} (from bottom), proceeding with profile link: ${profileUrl}`);
                        // Last-resort username from URL path segment
                        if (profileUrl) {
                            const parts = profileUrl.split('/').filter(Boolean);
                            username = parts[parts.length - 1] || 'Unknown';
                        } else {
                            username = 'Unknown';
                        }
                    }
                    if (processedUsers.has(username)) {
                        console.log(`⏭️ Skipping already processed user: ${username}`);
                        await new Promise(res => setTimeout(res, 6000));
                        continue;
                    }

                    console.log(`🔍 Checking user ${rows.length - i}/${rows.length} (row ${i} from bottom): ${username}`);
                    const rolimons = await scrapeRolimonsUserProfile(profileUrl);
                    rolimons.profileUrl = profileUrl; // Include the profile URL for webhook

                    if (rolimons.tradeAds > 500) {
                        console.log(`❌ Too many trade ads (${rolimons.tradeAds}), skipping ${username}`);
                        processedUsers.add(username);
                        await new Promise(res => setTimeout(res, 6000));
                        continue;
                    }
                    if (rolimons.value >= 6000000) {
                        console.log(`❌ Value too high (${rolimons.value}), skipping ${username}`);
                        processedUsers.add(username);
                        await new Promise(res => setTimeout(res, 6000));
                        continue;
                    }

                    // Process user immediately
                    console.log(`🔍 Processing user: ${username}`);
                    const hit = await lookupDiscordAndSend(username, rolimons);

                    // Wait 10 seconds before moving to the next user
                    await new Promise(res => setTimeout(res, 10000));
                    processedUsers.add(username);
                    if (hit) {
                        totalLogged++;
                    }

                } catch (error) {
                    console.error(`❌ Error processing row ${i} (from bottom):`, error.message);
                    // Add retry logic for critical errors
                    if (error.message.includes('failed to start a thread') || error.message.includes('SIGTRAP')) {
                        console.log('🔄 Critical error detected, attempting recovery...');
                        await new Promise(res => setTimeout(res, 10000)); // Wait 10 seconds
                        
                        // Try to reinitialize drivers if they're broken
                        try {
                            if (driver) {
                                await driver.quit();
                            }
                            if (profileDriver) {
                                await profileDriver.quit();
                            }
                        } catch (e) {
                            console.log('Error closing broken drivers:', e.message);
                        }
                        
                        // Reinitialize
                        await initializeWebDriver();
                        
                        // Skip this user and continue
                        processedUsers.add(username || `unknown_${i}`);
                        continue;
                    }
                }
            }
            console.log(`✅ Finished page ${page}/${totalPages}`);
        }
        console.log(`✅ All users processed for item ${itemId}. Total valid hits so far: ${totalLogged}`);
        isScraping = false;
    } catch (error) {
        console.error('❌ Error during scraping:', error.message);
        
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            console.log(`🔄 Restarting scrape in 10 seconds... (attempt ${retryCount}/${MAX_RETRIES})`);
            
            // Try to reinitialize drivers
            try {
                if (driver) await driver.quit();
                if (profileDriver) await profileDriver.quit();
            } catch (e) {
                console.log('Error closing drivers during restart:', e.message);
            }
            
            await initializeWebDriver();
            setTimeout(() => scrapeRolimonsItem(itemId), 10000);
        } else {
            console.log('❌ Max retries reached, giving up on this item');
            retryCount = 0; // Reset for next item
        }
    }
}

function parseLastOnlineDays(text) {
    text = text.toLowerCase();
    if (
        text.includes('second') ||
        text.includes('minute') ||
        text.includes('hour') ||
        text.includes('just now')
    ) {
        return 0;
    }
    const match = text.match(/(\d+)\s*day/);
    if (match) {
        return parseInt(match[1]);
    }
    return 999; // fallback for unknown format
}

async function scrapeRolimonsUserProfile(profileUrl, retryAttempt = 0) {
    if (!profileDriver) {
        console.error('❌ Profile driver not initialized');
        return {
            tradeAds: 0,
            rap: 0,
            value: 0,
            avatarUrl: '',
            lastOnlineText: 'Unknown',
            lastOnlineDays: 999
        };
    }

    try {
        await profileDriver.get(profileUrl);
        await profileDriver.sleep(2000);

        const getText = async (selector) => {
            try {
                const element = await profileDriver.findElement(By.css(selector));
                return await element.getText();
            } catch {
                return '';
            }
        };

        let tradeAds = 0;
        try {
            try {
                const tradeAdsElement = await profileDriver.findElement(By.css('span.card-title.mb-1.text-light.stat-data.text-nowrap'));
                const text = await tradeAdsElement.getText();
                if (text && !isNaN(text.replace(/,/g, ''))) {
                    tradeAds = parseInt(text.replace(/,/g, '')) || 0;
                    console.log(`✅ Found trade ads with exact selector: ${tradeAds}`);
                }
            } catch (e) {
                console.log('⚠️ Exact selector failed, trying contextual search...');
            }
            if (tradeAds === 0) {
                try {
                    const contextElements = await profileDriver.findElements(By.xpath("//*[contains(text(), 'Trade Ads') and contains(text(), 'Created')]/following::*[contains(@class, 'stat-data')][1] | //*[contains(text(), 'Trade Ads') and contains(text(), 'Created')]/..//*[contains(@class, 'stat-data')]"));
                    if (contextElements.length > 0) {
                        const text = await contextElements[0].getText();
                        if (text && !isNaN(text.replace(/,/g, ''))) {
                            tradeAds = parseInt(text.replace(/,/g, '')) || 0;
                            console.log(`✅ Found trade ads via "Trade Ads Created" context: ${tradeAds}`);
                        }
                    }
                } catch (e) {
                    console.log('⚠️ Contextual search failed, trying alternative selectors...');
                }
            }
            if (tradeAds === 0) {
                const selectors = [
                    '.card-title.mb-1.text-light.stat-data.text-nowrap',
                    'span.stat-data.text-nowrap',
                    '.stat-data.text-nowrap',
                    '.card-title.stat-data'
                ];
                for (const selector of selectors) {
                    try {
                        const elements = await profileDriver.findElements(By.css(selector));
                        for (const element of elements) {
                            const text = await element.getText();
                            if (text && /^\d{1,3}(,\d{3})*$/.test(text)) {
                                const numValue = parseInt(text.replace(/,/g, ''));
                                if (numValue > 0 && numValue <= 50000) {
                                    tradeAds = numValue;
                                    console.log(`✅ Found trade ads: ${tradeAds} using selector: ${selector}`);
                                    break;
                                }
                            }
                        }
                        if (tradeAds > 0) break;
                    } catch (e) { continue; }
                }
            }
            if (tradeAds === 0) {
                console.log('⚠️ Could not find trade ads with any method');
            }
        } catch (e) {
            console.log('⚠️ Error finding trade ads:', e.message);
        }
        const rap = parseInt((await getText('#player_rap')).replace(/,/g, '')) || 0;
        const value = parseInt((await getText('#player_value')).replace(/,/g, '')) || 0;
        const lastOnlineText = await getText('#location_pane_last_seen_online');

        let lastOnlineDays = parseLastOnlineDays(lastOnlineText);

        // Extract Roblox avatar image URL
        let avatarUrl = '';
        try {
            const avatarImg = await profileDriver.findElement(By.css('img.mx-auto.d-block.w-100.h-100[src^="https://tr.rbxcdn.com/"]'));
            avatarUrl = await avatarImg.getAttribute('src');
            if (avatarUrl) {
                console.log(`✅ Found avatar URL: ${avatarUrl.substring(0, 60)}...`);
            }
        } catch (e) {
            console.log('⚠️ Could not find avatar image:', e.message);
        }

        return {
            tradeAds,
            rap,
            value,
            avatarUrl,
            lastOnlineText,
            lastOnlineDays
        };
    } catch (error) {
        console.error('❌ Failed to scrape profile:', error.message);
        
        // Retry logic for profile scraping
        if (retryAttempt < MAX_RETRIES && (error.message.includes('failed to start a thread') || error.message.includes('SIGTRAP'))) {
            console.log(`🔄 Retrying profile scrape (attempt ${retryAttempt + 1}/${MAX_RETRIES})...`);
            await new Promise(res => setTimeout(res, 5000)); // Wait 5 seconds
            return await scrapeRolimonsUserProfile(profileUrl, retryAttempt + 1);
        }
        
        return {
            tradeAds: 0,
            rap: 0,
            value: 0,
            avatarUrl: '',
            lastOnlineText: 'Unknown',
            lastOnlineDays: 999
        };
    }
}

function extractDiscordFromRecord(record) {
    if (!record || typeof record !== 'object') return null;

    // Prefer explicit fields if present
    if (record.discord_tag) return String(record.discord_tag);
    if (record.discord_username && record.discriminator) {
        return `${record.discord_username}#${record.discriminator}`;
    }
    if (record.discord_username) return String(record.discord_username);

    // Nexus /lookup/roblox currently returns objects like:
    // { "username": "<discord username>", "score": 1100, "server_id": "..." }
    // So treat "username" as the Discord username when present.
    if (record.username) return String(record.username);

    // Fallback: any field whose key mentions "discord"
    const key = Object.keys(record).find(k => k.toLowerCase().includes('discord'));
    if (key && record[key]) {
        return String(record[key]);
    }

    return null;
}

async function lookupDiscordAndSend(robloxUsername, rolimonsData) {
    try {
        const response = await axios.get(YOUR_API_URL, {
            params: { query: robloxUsername },
            headers: {
                'x-admin-key': YOUR_ADMIN_KEY
            }
        });

        const body = response.data || {};
        const records = Array.isArray(body.data) ? body.data : [];

        if (!records.length) {
            console.log(`ℹ️ No Discord found for ${robloxUsername} (Nexus API returned empty data[])`);
            return false;
        }

        const discordRecord = records[0];
        const discordValue = extractDiscordFromRecord(discordRecord);

        if (!discordValue) {
            console.log(`ℹ️ Could not extract Discord field from Nexus API response for ${robloxUsername}`);
            return false;
        }

        await sendToWebhook(robloxUsername, discordValue, discordRecord, rolimonsData);
        await sendUsernameOnlyToWebhook(discordValue);
        return true;
    } catch (error) {
        console.error(`❌ Nexus API error for ${robloxUsername}:`, error.message);
        return false;
    }
}

async function sendToWebhook(robloxUsername, discordUsername, discordRecord, rolimonsData) {
    console.log(`📤 sendToWebhook called: Roblox=${robloxUsername}, Discord=${discordUsername}`);
    try {
        const fields = [];
        
        // Discord Username (primary field)
        fields.push({ 
            name: "Discord Username", 
            value: discordUsername, 
            inline: false 
        });
        
        // Discord ID if available from record
        if (discordRecord && discordRecord.user_id) {
            fields.push({ 
                name: "Discord ID", 
                value: discordRecord.user_id.toString(), 
                inline: true 
            });
        } else if (discordRecord && discordRecord.id) {
            fields.push({ 
                name: "Discord ID", 
                value: discordRecord.id.toString(), 
                inline: true 
            });
        }
        
        // Roblox Username
        fields.push({ 
            name: "Roblox Username", 
            value: robloxUsername, 
            inline: true 
        });
        
        // Rolimons Value
        if (rolimonsData && rolimonsData.value) {
            fields.push({ 
                name: "Value", 
                value: rolimonsData.value.toLocaleString(), 
                inline: true 
            });
        }
        
        // Trade Ads
        if (rolimonsData && rolimonsData.tradeAds !== undefined) {
            fields.push({ 
                name: "Trade Ads", 
                value: rolimonsData.tradeAds.toString(), 
                inline: true 
            });
        }
        
        // Build embed with thumbnail (avatar image)
        const embed = {
            title: "✨ New Discord Found!",
            color: 0x00AE86,
            fields: fields,
            timestamp: new Date().toISOString()
        };
        
        // Add thumbnail (Roblox avatar) if available
        if (rolimonsData && rolimonsData.avatarUrl) {
            embed.thumbnail = {
                url: rolimonsData.avatarUrl
            };
        }
        
        // Add Rolimons profile link if available
        if (rolimonsData && rolimonsData.profileUrl) {
            fields.push({
                name: "Rolimons Profile",
                value: `[View Profile](${rolimonsData.profileUrl})`,
                inline: false
            });
        }
        
        const payload = {
            embeds: [embed]
        };
        
        console.log('Sending webhook: new Discord found...');
        const response = await axios.post(WEBHOOK_URL, payload);
        console.log('✅ Webhook sent successfully, status:', response.status);
    } catch (e) {
        console.error('❌ Webhook POST error:', e.message);
        if (e.response) {
            console.error('Response status:', e.response.status);
            console.error('Response data:', e.response.data);
        }
    }
}

async function sendUsernameOnlyToWebhook(discordUsername) {
    console.log(`📤 Sending Discord username only to username webhook: ${discordUsername}`);
    try {
        const payload = {
            content: discordUsername
        };
        
        const response = await axios.post(USERNAME_WEBHOOK_URL, payload);
        console.log('✅ Username-only webhook sent successfully, status:', response.status);
    } catch (e) {
        console.error('❌ Username-only webhook POST error:', e.message);
        if (e.response) {
            console.error('Response status:', e.response.status);
            console.error('Response data:', e.response.data);
        }
    }
}

async function cleanup() {
    console.log('🧹 Cleaning up resources...');
    
    if (driver) {
        try {
            await driver.quit();
            console.log('✅ Main driver closed');
        } catch (e) {
            console.log('Error closing main driver:', e.message);
        }
    }
    
    if (profileDriver) {
        try {
            await profileDriver.quit();
            console.log('✅ Profile driver closed');
        } catch (e) {
            console.log('Error closing profile driver:', e.message);
        }
    }
    process.exit(0);
}

process.on('SIGINT', cleanup);

// Handle uncaught exceptions more gracefully - allow scraper to continue even if Discord bot fails
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await cleanup();
});
process.on('unhandledRejection', (e) => console.error('❌ Unhandled promise rejection:', e));

// Validate required environment variables
if (!WEBHOOK_URL) {
    console.error('❌ WEBHOOK_URL environment variable is required');
    process.exit(1);
}
if (!USERNAME_WEBHOOK_URL) {
    console.error('❌ USERNAME_WEBHOOK_URL environment variable is required');
    process.exit(1);
}
if (!YOUR_ADMIN_KEY) {
    console.error('❌ YOUR_ADMIN_KEY environment variable is required');
    process.exit(1);
}

// Railway deployment logging
console.log('🚀 Starting Railway deployment...');
console.log('📋 Configuration:');
console.log(`   - Webhook URL: ${WEBHOOK_URL.substring(0, 50)}...`);
console.log(`   - Username Webhook URL: ${USERNAME_WEBHOOK_URL.substring(0, 50)}...`);
console.log(`   - Your API URL: ${YOUR_API_URL}`);
console.log(`   - Item IDs: ${ITEM_IDS}`);

// Start Discord bot login (at the end, matching glazing.js pattern exactly)
if (USER_TOKEN && discordClient) {
    discordClient.login(USER_TOKEN).catch((e) => {
        console.error('❌ Failed to login to Discord:', e);
        console.log('ℹ️ Discord bot functionality disabled. Scraper will continue without Discord commands.');
        discordClient = null;
    });
} else {
    if (!USER_TOKEN) {
        console.log('ℹ️ USER_TOKEN not set. Discord bot functionality disabled.');
    }
}

startScraper();
