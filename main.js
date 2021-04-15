const Discord = require('discord.js');
const sgMail = require('@sendgrid/mail');
const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
const config = require('./config');

require('dotenv').config()

const client = new Discord.Client();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// generates a n-digit random code
function genCode(n) {
    var code = ''
    for (i = 0; i < n; i++) {
        code += String(Math.floor(Math.random() * 10));
    }
    return code;
}

// if email has not been verified, send verification code
async function verifyAndSendEmail(userid, email) {
    let domain = email.match('^[a-zA-Z0-9_.+-]+@(?:(?:[a-zA-Z0-9-]+\.)?[a-zA-Z]+\.)?(' + config.allowed_domains.join('|') + ')$');

    if (!(domain && config.allowed_domains.includes(domain[1]))) {
        return [
            null,
            'Please enter a valid Vanderbilt email address.'
        ];
    }

    const db = await sqlite.open({
        filename: config.db_path,
        driver: sqlite3.Database
    });

    let emailExists = null;
    try {
        emailExists = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);
    } catch (e) {
        console.error(e.toString());
        await db.close();
        return [
            {message: e.toString()},
            null
        ];
    }

    if (emailExists) {
        await db.close();
        return [
            null,
            'This email has already been verified.'
        ]
    }

    const code = genCode(6);

    const msg = {
        to: email,
        from: config.sendgrid.sender,
        templateId: config.sendgrid.template_id,
        dynamic_template_data: {
            code: code,
        },
    };

    try {
        await db.run(`
            INSERT INTO
              usercodes(userid, email, code)
            VALUES
              (?, ?, ?)
              ON CONFLICT(userid) DO
              UPDATE
              SET
                email = ?,
                code = ?,
                expires_at = DATETIME('now', '+24 hours')`,
            [userid, email, code, email, code]);
        await sgMail.send(msg);
    } catch (e) {
        console.error(e.toString());
        await db.close();
        return [
            {message: e.toString()},
            null
        ];
    }

    await db.close();
    return [
        null,
        `Please check your email \`${email}\` for a 6-digit verification code. Verify using \`!verify <code>\``
    ];
}

// verify code and role to access server
async function verifyAndAddRole(code, role_name, author) {
    let db = await sqlite.open({
        filename: config.db_path,
        driver: sqlite3.Database
    });

    // Fetch cached users
    let server = client.guilds.cache.get(config.discord.server_id);
    let role = server.roles.cache.find(role => role.name === role_name);
    let member = server.members.cache.get(author.id);

    if (member.roles.cache.find(role => role.name === role_name)) {
        return [
            null,
            'You\'re already verified!'
        ]
    }

    let row = await db.get(`
SELECT
  email
FROM usercodes
WHERE
  userid = ? AND
  code = ? AND
  expires_at > datetime('now')`,
        [author.id, code]);

    if (!row) {
        await db.close();
        return [
            null,
            'Invalid/Expired verification code.'
        ];
    }

    try {
        await member.roles.add(role);
    } catch (err) {
        return [
            {message: err.toString()},
            null
        ];
    }


    try {
        await db.run(`DELETE FROM usercodes WHERE userid = ?`, [author.id]);
        await db.run(`
            INSERT INTO
              users(userid, username, discriminator, email)
            VALUES
              (?, ?, ?, ?)
              ON CONFLICT(userid) DO
              UPDATE
              SET
                email = ?`,
            [author.id, author.username, author.discriminator, row.email, row.email]);
    } catch (e) {
        console.error(e.toString());
        await db.close();
        return [
            {message: e.toString()},
            null
        ];
    }

    await db.close();
    return [
        null,
        `Thanks! You have now been verified and can access the server!`
    ];
}

// who are you???
async function whoami(userid) {
    let db = await sqlite.open({
        filename: config.db_path,
        driver: sqlite3.Database
    });

    var row = null;
    try {
        row = await db.get(`
SELECT
  email
FROM users
WHERE
  userid = ?`,
            [userid]);
    } catch (e) {
        console.error(e.toString());
        await db.close();
        return [
            {message: e.toString()},
            null
        ];
    }

    if (!row) {
        return [
            null,
            `
Hmmm I'm really not sure myself but I'd love to get to know you!
Use \`!iam <you@vanderbilt.edu>\` and verify your email address.`
        ]
    }

    await db.close();
    return [
        null,
        `
Your verified email address is ${row.email}`
    ];
}

// get information on a user
async function getUser(username, discriminator) {
    let db = await sqlite.open({
        filename: config.db_path,
        driver: sqlite3.Database
    });

    var row = null;
    try {
        row = await db.get(`
SELECT
  *
FROM users
WHERE
  username = ? AND
  discriminator = ?`,
            [username, discriminator]);
    } catch (e) {
        console.error(e.toString());
        await db.close();
        return [
            {message: e.toString()},
            null
        ];
    }

    if (!row) {
        return [
            null,
            'User not found.'
        ]
    }

    await db.close();
    return [
        null,
        `
Email: ${row.email}`
    ];
}

// on ready, create db and tables if they don't already exist
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    let db = await sqlite.open({
        filename: config.db_path,
        driver: sqlite3.Database
    });

    await db.exec('CREATE TABLE IF NOT EXISTS usercodes(userid text, email text, code text, expires_at DATE DEFAULT (DATETIME(\'now\', \'+24 hours\')), PRIMARY KEY (userid))');
    await db.exec('CREATE TABLE IF NOT EXISTS users(userid text, username text, discriminator text, email text, PRIMARY KEY (userid))');

    await db.close();
});

// on new user, dm him with info and verification instructions
client.on('guildMemberAdd', member => {
    member.send(`
Welcome to the Vanderbilt Student Government's Discord Server!
To access the server please verify yourself using your Vanderbilt email address. Don't worry, this email address will not be linked to your Discord account in any way and is only for verification purposes.
You can verify your email by replying with \`!iam <you@vanderbilt.edu>\`.
You will be emailed a 6-digit verification code and you can let me know by \`!verify <code>\`.

Hope to see you soon!

Available commands:
\`!iam <you@vanderbilt.edu>\`: request a 6-digit verification code to verify your email address.
\`!verify <code>\`: verify the code that has been emailed to you.
\`!whoami\`: check your verified email address.`);
});

// on new message
client.on('message', async msg => {
    if (msg.author.bot === true || msg.channel.type !== 'dm') {
        return;
    }

    let server = client.guilds.cache.get(config.discord.server_id);
    let member = server.members.cache.get(msg.author.id);

    let cmd = msg.content.split(' ');
    if (cmd.length < 1) {
        return;
    }

    // verify for the first time
    if (cmd.length >= 2 && cmd[0] === '!iam') {
        let email = cmd[1].toLowerCase();
        let [err, message] = await verifyAndSendEmail(msg.author.id, email);
        if (err) {
            msg.reply('Something went wrong!\n`' + err.message + '`');
        }
        if (message) {
            msg.reply(message);
        }
    }

    // verify code
    else if (cmd.length >= 2 && cmd[0] === '!verify') {
        let code = cmd[1];
        let [err, message] = await verifyAndAddRole(code, config.discord.verified_role_name, msg.author);
        if (err) {
            msg.reply('Something went wrong!\n`' + err.message + '`');
            return;
        }
        if (message) {
            msg.reply(message);
        }
    }

    // who are you???
    else if (cmd[0] === '!whoami') {
        let [err, message] = await whoami(msg.author.id);
        if (err) {
            msg.reply('Something went wrong!\n`' + err.message + '`');
            return;
        }
        if (message) {
            msg.reply(message);
        }
    }

    // lookup a user
    else if (member.hasPermission('ADMINISTRATOR') && cmd[0] === '!lookup') {
        if (cmd.length < 1 || !cmd[1].match('.+#([0-9]){4}')) {
            msg.reply('Invalid command. Format: `!lookup <username>#<discriminator>`');
            return;
        }

        let [username, discriminator] = cmd[1].split('#');

        let [err, message] = await getUser(username, discriminator);
        if (err) {
            msg.reply('Something went wrong!\n`' + err.message + '`');
            return;
        }
        if (message) {
            msg.reply(message);
        }

    } else {
        msg.reply(`
Invalid command/format.
Available commands:
\`!iam <you@vanderbilt.edu>\`: request a 6-digit verification code to verify your email address.
\`!verify <code>\`: verify the code that has been emailed to you.
\`!whoami\`: check your verified email address.`);
    }
});

client.login(process.env.DISCORD_API_KEY);

