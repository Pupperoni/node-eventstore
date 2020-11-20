const Bluebird = require('bluebird');
const EventstorePlaybackListStore = require('../../lib/eventstore-projections/eventstore-playbacklist-mysql-store');
const EventstorePlaybackListView = require('../../lib/eventstore-projections/eventstore-playback-list-view');
const shortid = require('shortid');

const mysqlOptions = {
    host: 'localhost',
    port: 13306,
    user: 'root',
    password: 'root',
    database: 'playbacklist_db',
    connectionLimit: 10
};

const mysqlServer = (function() {
    const sleepAsync = function(sleepUntil) {
        return new Promise((resolve) => {
            setTimeout(resolve, sleepUntil);
        });
    }

    const exec = require('child_process').exec;
    const mysql = require('mysql');

    return {
        up: async function() {
            const command = `docker run --name eventstore_playbacklist_view_mysql -e MYSQL_ROOT_PASSWORD=${mysqlOptions.password} -e MYSQL_DATABASE=${mysqlOptions.database} -p ${mysqlOptions.port}:3306 -d mysql:5.7`;
            const process = exec(command);

            // wait until process has exited
            console.log('downloading mysql image or creating a container. waiting for child process to return an exit code');
            do {
                await sleepAsync(1000);
            } while (process.exitCode == null);

            console.log('child process exited with exit code: ', process.exitCode);

            console.info('waiting for mysql database to start...');
            let retries = 0;
            let gaveUp = true;
            let conn = null;
            do {
                try {
                    conn = mysql.createConnection(mysqlOptions);

                    Bluebird.promisifyAll(conn);

                    await conn.connectAsync();
                    console.log('connected!');
                    gaveUp = false;
                    break;
                } catch (error) {
                    conn.end();
                    console.log(`mysql retry attempt ${retries + 1} after 1000ms`);
                    await sleepAsync(1000);
                    retries++;
                }
            } while (retries < 20);

            if (gaveUp) {
                console.error('given up connecting to mysql database');
                console.error('abandoning tests');
            } else {
                console.log('successfully connected to mysql database');
            }
        },
        down: async function() {
            exec('docker rm eventstore_playbacklist_view_mysql --force');
        }
    }
})();

describe('eventstore-playback-list-view-mysql-store tests', () => {
    let eventstorePlaybackListStore = new EventstorePlaybackListStore();
    let eventstorePlaybackListView = new EventstorePlaybackListView();
    let eventstorePlaybackListViewOptimized = new EventstorePlaybackListView();

    let listName;
    beforeAll(async (done) => {
        await mysqlServer.up();

        eventstorePlaybackListStore = new EventstorePlaybackListStore(mysqlOptions);
        await eventstorePlaybackListStore.init();

        let randomString = 'list_' + shortid.generate();
        randomString = randomString.replace('-', '');
        listName = 'list_' + randomString;

        await eventstorePlaybackListStore.createList({
            name: listName,
            fields: [{
                name: 'vehicleId',
                type: 'string'
            },
            {
                name: 'accessDate',
                type: 'date'
            }]
        });

        // add items to our list
        for (let i = 0; i < 10; i++) {
            const rowId = shortid.generate();
            const revision = i;
            const data = {
                vehicleId: 'vehicle_' + revision,
                accessDate: `2020-11-${(revision+1) >= 10 ? (revision+1) : '0' + (revision+1)}`
            };
            const meta = {
                streamRevision: revision
            }

            await eventstorePlaybackListStore.add(listName, rowId, revision, data, meta);
        }

        eventstorePlaybackListView = new EventstorePlaybackListView({
            host: mysqlOptions.host,
            port: mysqlOptions.port,
            database: mysqlOptions.database,
            user: mysqlOptions.user,
            password: mysqlOptions.password,
            listName: "list_view_1",
            query: `SELECT * FROM ${listName}`,
            alias: undefined
        });
        Bluebird.promisifyAll(eventstorePlaybackListView);
        await eventstorePlaybackListView.init();

        eventstorePlaybackListViewOptimized = new EventstorePlaybackListView({
            host: mysqlOptions.host,
            port: mysqlOptions.port,
            database: mysqlOptions.database,
            user: mysqlOptions.user,
            password: mysqlOptions.password,
            listName: "list_view_2",
            query: `SELECT * FROM ${listName} AS vehicle_list @@where @@order @@limit; SELECT COUNT(1) AS total_count FROM ${listName} AS vehicle_list @@where;`,
            alias: {
                vehicleId: `vehicle_list.vehicleId`,
                accessDate: `vehicle_list.accessDate`
            }
        });
        Bluebird.promisifyAll(eventstorePlaybackListViewOptimized);
        await eventstorePlaybackListViewOptimized.init();

        done();
    }, 60000);

    describe('query', () => {
        it('should return the correct results based on the query parameters passed using LISTVIEW', async (done) => {
            try {
                const allResultsInserted = await eventstorePlaybackListView.queryAsync(0, 10, null, null);
                expect(allResultsInserted.count).toEqual(10);
                expect(allResultsInserted.rows.length).toEqual(10);

                const pagedResults = await eventstorePlaybackListView.queryAsync(5, 5, null, null);
                // should get revision 5 - 9
                expect(pagedResults.count).toEqual(10); // total still 10
                expect(pagedResults.rows.length).toEqual(5); // paged should be 5

                const filteredResults = await eventstorePlaybackListView.queryAsync(0, 5, [{
                    field: 'vehicleId',
                    operator: 'is',
                    value: 'vehicle_5'
                },{
                    field: 'accessDate',
                    operator: 'dateRange',
                    from: '2020-11-01',
                    to: '2020-11-10'
                }], null);
                expect(filteredResults.count).toEqual(1); // total still 10
                expect(filteredResults.rows.length).toEqual(1);
                expect(filteredResults.rows[0].revision).toEqual(5);
                expect(filteredResults.rows[0].data.vehicleId).toEqual('vehicle_5');

                const sortedResults = await eventstorePlaybackListView.queryAsync(0, 10, null, [{
                    field: 'vehicleId',
                    sortDirection: 'ASC'
                }]);

                expect(sortedResults.count).toEqual(10); // total still 10
                expect(sortedResults.rows.length).toEqual(10);
                expect(sortedResults.rows[0].revision).toEqual(0);
                expect(sortedResults.rows[0].data.vehicleId).toEqual('vehicle_0');

                done();
            } catch (error) {
                console.log(error);
                throw error;
            }
        });

        it('should return the correct results based on the query parameters passed using optimized query', async (done) => {
            try {
                const allResultsInserted = await eventstorePlaybackListViewOptimized.queryAsync(0, 10, null, null);
                expect(allResultsInserted.count).toEqual(10);
                expect(allResultsInserted.rows.length).toEqual(10);

                const pagedResults = await eventstorePlaybackListViewOptimized.queryAsync(5, 5, null, null);
                // should get revision 5 - 9
                expect(pagedResults.count).toEqual(10); // total still 10
                expect(pagedResults.rows.length).toEqual(5); // paged should be 5

                const filteredResults = await eventstorePlaybackListViewOptimized.queryAsync(0, 5, [{
                    field: 'vehicleId',
                    operator: 'is',
                    value: 'vehicle_5'
                }], null);
                expect(filteredResults.count).toEqual(1); // total still 10
                expect(filteredResults.rows.length).toEqual(1);
                expect(filteredResults.rows[0].revision).toEqual(5);
                expect(filteredResults.rows[0].data.vehicleId).toEqual('vehicle_5');

                const sortedResults = await eventstorePlaybackListViewOptimized.queryAsync(0, 10, null, [{
                    field: 'vehicleId',
                    sortDirection: 'ASC'
                }]);

                expect(sortedResults.count).toEqual(10); // total still 10
                expect(sortedResults.rows.length).toEqual(10);
                expect(sortedResults.rows[0].revision).toEqual(0);
                expect(sortedResults.rows[0].data.vehicleId).toEqual('vehicle_0');

                done();
            } catch (error) {
                console.log(error);
                throw error;
            }
        })
    });

    afterAll(async (done) => {
        // NOTE: uncomment if we need to terminate the mysql every test
        // for now, it is okay since we are using a non-standard port (13306) and a fixed docker container name
        // not terminating will make the tests faster by around 11 secs
        await eventstorePlaybackListStore.close();
        // await mysqlServer.down();
        done();
    })
});