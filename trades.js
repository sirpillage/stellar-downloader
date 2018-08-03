var stellar = require('stellar-sdk')

if (process.argv.length <= 2) {
    printDisplay("need to pass in the account as a command line argument");
    process.exit()
}

var account = process.argv[2]
var server = new stellar.Server('https://horizon.stellar.org');
var limit = 200;

var header = ['type','paging_token','date','bought_asset','bought_amount','sell_asset','sell_amount','counterparty_account','XLM']
var asset_map = {'XLM' : 0};
var asset_list = ['XLM'];
// payment, account_created, and account_merge type payments keyed by paging_token
var payments = {};
var last_payment_cursor = "";

var to_csv = function(arr) {
    s = ""
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] != null) {
            s += arr[i];
        }
        s += ",";
    }
    return s;
}

var printDisplay = function(str) {
    console.error(str);
}

var writeHistory = function(str) {
    console.log(str);
}

var register = function(a, start_amount) {
    if (!(a in asset_map)) {
        asset_map[a] = start_amount;
        asset_list.push(a);
        header.push(a);
        printDisplay("");
        printDisplay(to_csv(header));
    }
}

// TODO need to have this run one step ahead of the tradesPrinter
var paymentsHandler = function(t) {
    var last_cursor = "";
    t.records.forEach(function(r) {
        if (r.type == 'create_account') {
            payments[r.paging_token] = {
                type: r.type,
                account: r.account,
                funder: r.funder,
                starting_balance: r.starting_balance
            };
        } else if (r.type == 'payment') {
            asset = r.asset_type == 'native' ? 'XLM' : r.asset_code + ":" + r.asset_issuer;
            payments[r.paging_token] = {
                type: r.type,
                from: r.from,
                to: r.to,
                asset: asset,
                amount: r.amount
            };
        } else if (r.type == 'account_merge') {
            payments[r.paging_token] = {
                type: r.type,
                account: r.account,
                into: r.into
            };
        }
        last_cursor = r.paging_token;
        last_payment_cursor = r.paging_token;
    });

    if (last_cursor != '') {
        server.payments()
            .forAccount(account)
            .order("asc")
            .limit(limit)
            .cursor(last_cursor)
            .call()
            .then(paymentsHandler)
    }
}

var appendAssets = function(list) {
    for (i = 0; i < asset_list.length; i++) {
        value = asset_map[asset_list[i]]
        list.push(value);
    }
}

var mapData = function(effect_paging_token) {
    payment_pt = effect_paging_token.split("-")[0];
    return payments[payment_pt];
}

var tradesPrinter = function(t) {
    var last_cursor = "";
    t.records.forEach(function(r) {
        last_cursor = r.paging_token;
        var line = [];
        // TODO need to check if m_data is available or not in all these cases, sometimes the corresponding operation may not exist on the current account so we will need to fetch the operation on the effect
        if (r.type == 'account_created') {
            // only applies to the current account being created
            m_data = mapData(r.paging_token);
            line = ['genesis', r.paging_token, r.created_at, 'XLM', r.starting_balance, null, null, m_data['funder']];
            asset_map['XLM'] += r.starting_balance;
        } else if (r.type == 'account_debited') {
            m_data = mapData(r.paging_token);
            if (m_data['type'] == 'payment') {
                line = ['payment_sent', r.paging_token, r.created_at, null, null, m_data['asset'], r.amount, m_data['to']];
                asset_map[m_data['asset']] -= r.amount;
            } else if (m_data['type'] == 'create_account') {
                line = ['account_created', r.paging_token, r.created_at, null, null, 'XLM', m_data['starting_balance'], m_data['account']];
                asset_map['XLM'] -= m_data['starting_balance'];
                // TODO need to spider this account
            } else if (m_data['type'] == 'account_merge') {
                line = ['payment_sent', r.paging_token, r.created_at, null, null, 'XLM', r.amount, m_data['into']];
                asset_map['XLM'] -= r.amount;
            } 
        } else if (r.type == 'account_credited') {
            m_data = mapData(r.paging_token);
            if (m_data['type'] == 'payment') {
                line = ['payment_received', r.paging_token, r.created_at, m_data['asset'], r.amount, null, null, m_data['from']];
                asset_map[m_data['asset']] += r.amount;
            } else if (m_data['type'] == 'account_merge') {
                line = ['payment_received', r.paging_token, r.created_at, 'XLM', r.amount, null, null, m_data['account']];
                asset_map['XLM'] += r.amount;
            }
            // TODO raise
            // it is never the case that effect is account_credited and operation is created_account (that's why we have the account_created effect)
        } else if (r.type == 'trade') {
            bought_asset = r.bought_asset_type == 'native' ? 'XLM' : r.bought_asset_code + ":" + r.bought_asset_issuer;
            sold_asset = r.sold_asset_type == 'native' ? 'XLM' : r.sold_asset_code + ":" + r.sold_asset_issuer;
            line = ['trade', r.paging_token, r.created_at, bought_asset, r.bought_amount, sold_asset, r.sold_amount, r.seller];
            register(bought_asset, r.bought_amount);
            asset_map[sold_asset] -= r.sold_amount;
        } else if (r.type == 'account_removed') {
            line = ['end', r.paging_token, r.created_at, null, null, null, null, null];
        } else {
            return;
        }

        appendAssets(line);
        writeHistory(to_csv(line));
    });

    if (last_cursor != '') {
        server.effects()
            .forAccount(account)
            .order("asc")
            .limit(limit)
            .cursor(last_cursor)
            .call()
            .then(tradesPrinter);
    }
}

server.loadAccount(account).then(function(a) {
    writeHistory('Trades for account: ' + account);
    writeHistory(to_csv(header));

    server.payments()
        .forAccount(account)
        .order("asc")
        .limit(limit)
        .call()
        .then(paymentsHandler)

    server.effects()
        .forAccount(account)
        .order("asc")
        .limit(limit)
        .call()
        .then(tradesPrinter);
});
