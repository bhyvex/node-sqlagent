var database = require('mysql');
var Url = require('url');
var Events = require('events');
require('./index');

function SqlBuilder(skip, take) {
    this.builder = [];
    this._order = null;
    this._skip = skip >= 0 ? skip : 0;
    this._take = take >= 0 ? take : 0;
}

SqlBuilder.prototype.order = function(name, desc) {

    var self = this;

    if (self._order === null)
        self._order = [];

    var lowered = name.toLowerCase();

    if (lowered.lastIndexOf('desc') !== -1 || lowered.lastIndexOf('asc') !== -1) {
        self._order.push(name);
        return self;
    } else if (typeof(desc) === 'boolean')
        desc = desc === true ? 'DESC' : 'ASC';

    self._order.push(SqlBuilder.column(name) + ' ' + desc);
    return self;
};

SqlBuilder.prototype.skip = function(value) {
    var self = this;
    self._skip = value;
    return self;
};

SqlBuilder.prototype.take = function(value) {
    var self = this;
    self._take = value;
    return self;
};

SqlBuilder.prototype.first = function() {
    var self = this;
    self._skip = 0;
    self._take = 1;
    return self;
};

SqlBuilder.prototype.where = function(name, operator, value) {
    return this.push(name, operator, value);
};

SqlBuilder.prototype.push = function(name, operator, value) {
    var self = this;

    if (value === undefined) {
        value = operator;
        operator = '=';
    }

    self.builder.push(SqlBuilder.column(name) + operator + SqlBuilder.escape(value));
    return self;
};

SqlBuilder.escape = function(value) {

    if (value === null || value === undefined)
        return 'null';

    var type = typeof(value);

    if (type === 'boolean')
        return value === true ? '1' : '0';

    if (type === 'number')
        return value.toString();

    if (type === 'string')
        return database.escape(value);

    if (value instanceof Array)
        return database.escape(value.join(','));

    if (value instanceof Date)
        return value.toISOString();

    return database.escape(value.toString());
};

SqlBuilder.column = function(name) {
    return '`' + name + '`';
};

SqlBuilder.prototype.group = function(name, values) {
    var self = this;
    self.builder.push(SqlBuilder.column(name) + ' GROUP BY ' + (values instanceof Array ? values.join(',') : values));
    return self;
};

SqlBuilder.prototype.having = function(condition) {
    var self = this;
    self.builder.push(condition);
    return self;
};

SqlBuilder.prototype.and = function() {
    var self = this;
    if (self.builder.length === 0)
        return self;
    self.builder.push('AND');
    return self;
};

SqlBuilder.prototype.or = function() {
    var self = this;
    if (self.builder.length === 0)
        return self;
    self.builder.push('OR');
    return self;
};

SqlBuilder.prototype.in = function(name, value) {

    var self = this;

    if (!(value instanceof Array))
        return self;

    var values = [];

    for (var i = 0, length = value.length; i < length; i++)
        values.push(SqlBuilder.escape(value[i]));

    self.builder.push(SqlBuilder.column(name) + ' IN (' + values.join(',') + ')');
    return self;
};

SqlBuilder.prototype.like = function(name, value) {
    var self = this;
    self.builder.push(SqlBuilder.column(name) + ' LIKE ' + SqlBuilder.escape(value));
    return self;
};

SqlBuilder.prototype.between = function(name, valueA, valueB) {
    var self = this;
    self.builder.push(SqlBuilder.column(name) + ' BETWEEN ' + valueA + ' AND ' + valueB);
    return self;
};

SqlBuilder.prototype.sql = function(sql) {
    var self = this;
    self.builder.push(sql);
    return self;
};

SqlBuilder.prototype.toString = function() {

    var self = this;
    var plus = '';
    var order = '';

    if (self._order)
        order = ' ORDER BY ' + self._order.join(',');

    if (self._skip > 0 && self._take > 0)
        plus = ' LIMIT ' + self._skip + ',' + self._take;
    else if (self._take > 0)
        plus = ' LIMIT ' + self._take;
    else if (self._skip > 0)
        plus = ' LIMIT ' + self._skip + ',row_count';

    if (self.builder.length === 0)
        return plus;

    return ' WHERE ' + self.builder.join(' ') + order + plus;
};

function Agent(options) {

    if (typeof(options) === 'string') {
        var opt = Url.parse(options);
        var auth = opt.auth.split(':');
        options = {};
        options.host = opt.hostname;
        options.user = auth[0] || '';
        options.password = auth[1] || '';
        options.database = (opt.pathname || '').substring(1) || '';
    }

    this.options = options;
    this.command = [];
    this.db = null;
    this.done = null;
    this.autoclose = true;
    this.last = null;
    this.id = null;
    this.isCanceled = false;
}

Agent.prototype = {
    get $() {
        return new SqlBuilder();
    }
};

Agent.prototype.__proto__ = Object.create(Events.EventEmitter.prototype, {
    constructor: {
        value: Agent,
        enumberable: false
    }
});

Agent.prototype.query = function(name, query, params, before, after) {
    var self = this;
    return self.push(name, query, params, before, after);
};

Agent.prototype.push = function(name, query, params, before, after) {
    var self = this;

    if (typeof(query) !== 'string') {
        after = before;
        before = params;
        params = query;
        query = name;
        name = self.command.length;
    }

    self.command.push({ name: name, query: query, params: params, before: before, after: after, first: query.substring(query.length - 7).toLowerCase() === 'limit 1' });
    return self;
};

Agent.prototype.validate = function(fn) {
    return this.cancel(fn);
};

Agent.prototype.cancel = function(fn) {
    var self = this;
    if (fn === undefined) {
        fn = function(err, results) {
            if (self.last === null)
                return false;
            var r = results[self.last];
            if (r instanceof Array)
                return r.length > 0;
            return r !== null && r !== undefined;
        };
    }
    self.command.push({ type: 'cancel', before: fn });
    return self;
};

Agent.prototype.begin = function() {
    var self = this;
    self.command.push({ type: 'begin' });
    return self;
};

Agent.prototype.end = function() {
    var self = this;
    self.command.push({ type: 'end' });
    return self;
};

Agent.prototype._insert = function(item) {

    var self = this;
    var name = item.name;
    var values = item.values;
    var table = item.table;
    var keys = Object.keys(values);

    var columns = [];
    var columns_values = [];
    var params = [];
    var index = 1;

    for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];
        var value = values[key];

        if (item.without && item.without.indexOf(key) !== -1)
            continue;

        if (key[0] === '$')
            continue;

        columns.push('`' + key + '`');
        columns_values.push('?');
        params.push(value === undefined ? null : value);
    }

    return { name: name, query: 'INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES(' + columns_values.join(',') + ')', params: params, first: true };
};

Agent.prototype._update = function(item) {

    var self = this;
    var name = item.name;
    var values = item.values;
    var condition = item.condition;
    var table = item.table;
    var keys = Object.keys(values);

    var columns = [];
    var params = [];
    var index = 1;

    for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];
        var value = values[key];

        if (item.without && item.without.indexOf(key) !== -1)
            continue;

        if (key[0] === '$')
            continue;

        columns.push('`' + key + '`=?');
        params.push(value === undefined ? null : value);
    }

    return { name: name, query: 'UPDATE ' + table + ' SET ' + columns.join(',') + condition.toString(), params: params, first: true };

};

Agent.prototype._select = function(item) {
    return { name: item.name, query: item.query + item.condition.toString(), params: null, first: item.condition._take === 1 };
};

Agent.prototype._delete = function(item) {
    return { name: item.name, query: item.query + item.condition.toString(), params: null, first: true };
};

Agent.prototype.insert = function(name, table, values, without, before, after) {

    var self = this;

    if (typeof(table) !== 'string') {
        after = before;
        before = without;
        without = values;
        values = table;
        table = name;
        name = self.command.length;
    }

    self.command.push({ type: 'insert', table: table, name: name, values: values, without: without, before: before, after: after });
    return self;
};

Agent.prototype.select = function(name, table, schema, without, skip, take, before, after) {

    var self = this;

    if (typeof(table) !== 'string') {
        after = before;
        before = take;
        take = skip;
        skip = without;
        without = schema;
        schema = table;
        table = name;
        name = self.command.length;
    }

    var columns = [];
    var arr = Object.keys(schema);

    for (var i = 0, length = arr.length; i < length; i++) {

        if (without && without.indexOf(arr[i]) !== -1)
            continue;

        if (arr[i][0] === '$')
            continue;

        columns.push(SqlBuilder.column(arr[i]));
    }

    var condition = new SqlBuilder(skip, take);
    self.command.push({ type: 'select', query: 'SELECT ' + columns.join(',') + ' FROM ' + table, name: name, values: null, without: without, before: before, after: after, condition: condition });
    return condition;
};

Agent.prototype.update = function(name, table, values, without, before, after) {

    var self = this;

    if (typeof(table) !== 'string') {
        after = before;
        before = without;
        without = values;
        values = table;
        table = name;
        name = self.command.length;
    }

    var condition = new SqlBuilder();
    self.command.push({ type: 'update', table: table, name: name, values: values, without: without, before: before, after: after, condition: condition });
    return condition;
};

Agent.prototype.delete = function(name, table, before, after) {

    var self = this;

    if (typeof(table) !== 'string') {
        after = before;
        before = table;
        table = name;
        name = self.command.length;
    }

    var condition = new SqlBuilder();
    self.command.push({ type: 'delete', query: 'DELETE FROM ' + table, name: name, values: null, without: null, before: before, after: after, condition: condition });
    return condition;

};

Agent.prototype.remove = function(name, table, before, after) {
    return this.delete(name, table, before, after);
};

Agent.prototype.destroy = function(name) {

    var self = this;

    for (var i = 0, length = self.command.length; i < length; i++) {

        var item = self.command[i];
        if (item.name !== name)
            continue;

        self.command.splice(i, 1);
        return true;

    }

    return false;
};

Agent.prototype.close = function() {
    var self = this;
    self.done();
    self.db = null;
    return self;
};

Agent.prototype.prepare = function(callback) {

    var results = {};
    var errors = [];
    var self = this;
    var rollback = false;
    var isTransaction = false;

    self.command.sqlagent(function(item, next) {

        var hasError = errors.length > 0 ? errors : null;

        if (item.type === 'cancel') {
            if (item.before(hasError, results) === false) {
                errors.push('cancel');
                self.isCanceled = true;
                self.command = [];
                results = null;
                next(false);
                return;
            }
            next();
            return;
        }

        if (item.before && item.before(hasError, results, item.values, item.condition) === false) {
            next();
            return;
        }

        var current = item.type === 'update' ? self._update(item) : item.type === 'insert' ? self._insert(item) : item.type === 'select' ? self._select(item) : item.type === 'delete' ? self._delete(item) : item;

        if (current.params instanceof SqlBuilder) {
            current.query = current.query + current.params.toString();
            current.params = undefined;
        }

        var query = function(err, rows) {

            if (err) {
                errors.push(err.message);
                if (isTransaction)
                    rollback = true;
            } else {

                if (current.type === 'insert')
                    self.id = rows.insertId;

                results[current.name] = current.first ? rows instanceof Array ? rows[0] : rows : rows;
                self.emit('data', current.name, results);
            }

            self.last = item.name;

            if (item.after)
                item.after(errors.length > 0 ? errors : null, results, current.values, current.condition);

            next();
        };

        if (item.type !== 'begin' && item.type !== 'end') {
            self.emit('query', current.name, current.query);
            self.db.query(current.query, current.params, query);
            return;
        }

        if (item.type === 'begin') {
            self.db.beginTransaction(function(err) {

                if (err) {
                    errors.push(err.message);
                    self.command = [];
                    next();
                    return;
                }

                isTransaction = true;
                rollback = false;
                next();
            });
            return;
        }

        if (item.type === 'end') {

            isTransaction = false;

            if (rollback) {
                self.db.rollback(function(err) {
                    if (!err)
                        return next();
                    self.command = [];
                    self.push(err.message);
                    next();
                });
                return;
            }

            self.db.commit(function(err) {

                if (!err)
                    return next();

                errors.push(err.message);
                self.command = [];

                connection.rollback(function(err) {
                    if (!err)
                        return next();
                    errors.push(err.message);
                    next();
                });

            });

            return;
        }

    }, function() {

        if (self.autoclose) {
            self.done();
            self.db = null;
        }

        var err = errors.length > 0 ? errors : null;

        if (!err) {

            self.emit('end', null, results);

            if (callback)
                callback(null, results);

            return;
        }

        self.emit('end', err, results);

        if (callback)
            callback(err, results);

    });

    return self;
};

Agent.prototype.exec = function(callback, autoclose) {

    var self = this;

    if (autoclose !== undefined)
        self.autoclose = autoclose;

    if (self.command.length === 0) {
        if (callback)
            callback.call(self, null, {});
        return self;
    }

    var connection = database.createConnection(self.options);

    connection.connect(function(err) {

        if (err) {
            callback.call(self, err, null);
            return;
        }

        self.done = function() {
            connection.end();
        };

        self.db = connection;
        self.prepare(callback);

    });

    return self;
};

module.exports = Agent;