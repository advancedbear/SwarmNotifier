require('dotenv').config();
const express = require('express');
const sqlite3 = require("sqlite3");
const axios = require("axios").default;
const app = express();
const port = 3000;

const db = new sqlite3.Database("./main.db", (err) => {
    if (err) {
        console.error("database error: " + err.message);
    } else {
        db.serialize(() => {
            //table生成（無ければ）
            db.run("create table if not exists members( \
                id integer primary key, \
                token nverchar(50) \
            )", (err) => {
                if (err) {
                    console.error("table error: " + err.message);
                }
            });
        });
    }
});

app.use(express.json());
app.use(express.urlencoded({
    extended: true
}));

app.post('/webhook', (req, res) => {
    console.log('Received webhook request from user_id:', JSON.parse(req.body.user).id);
    db.get("select * from members where id = ?", JSON.parse(req.body.user).id, (err, row) => {
        if (err) {
            res.status(400).send('Webhook received failed!')
        } else {
            if (row) {
                axios.get('https://api.foursquare.com/v2/users/self/checkins', {
                    params: {
                        v: "20241201",
                        limit: 1,
                        offset: 0,
                        oauth_token: row.token
                    }
                }).then((response) => {
                    console.log(response.data.response.checkins.items[0])
                    res.status(200).send('Webhook received successfully!');
                }).catch((err) => {
                    console.error(err)
                    res.status(400).send('Webhook received failed!')
                })
            } else {
                console.log('User has not been registered.')
                res.status(400).send('Webhook received failed!')
            }
        }
    })
});

app.get('/register', (req, res) => {
    console.log('Received register request.');
    res.redirect(`https://foursquare.com/oauth2/authenticate?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${process.env.REDIRECT_URL}`)
})

app.get('/login', (req, res) => {
    console.log('Received login request:', req.query);
    if (req.query["code"]) {
        axios.get(`https://foursquare.com/oauth2/access_token`, {
            params: {
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: "authorization_code",
                redirect_uri: process.env.REDIRECT_URL,
                code: req.query.code
            }
        })
            .then((response) => {
                console.log(response.status)
                let oauth_token = response.data.access_token
                axios.get('https://api.foursquare.com/v2/users/self', {
                    params: {
                        v: "20241201",
                        oauth_token: oauth_token
                    }
                }).then((response) => {
                    // console.log(response.data)
                    db.get("select * from members", (err, row) => {
                        console.log(row)
                    })
                    let user_id = response.data.response.user.id
                    const stmt = db.prepare("insert into members(id,token) values(?,?) on conflict(id) do update set token = excluded.token");
                    stmt.run(user_id, oauth_token, (err, result) => {
                        if (err) {
                            res.status(400).json({
                                "status": "error",
                                "message": err.message
                            });
                            return;
                        } else {
                            res.status(200).json({
                                "status": "OK",
                                "lastID": stmt.lastID
                            });
                        }
                    })
                }).catch((err) => {
                    res.status(400).json({
                        "status": "error",
                        "message": JSON.stringify(err)
                    });
                })

            })
    }
    // res.status(200).send('Webhook received successfully!');
})

app.listen(port, () => {
    console.log(`Server is running on port ${port} `);
});