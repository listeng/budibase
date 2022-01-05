const threadUtils = require("./utils")
threadUtils.threadSetup()
const ScriptRunner = require("../utilities/scriptRunner")
const { integrations } = require("../integrations")
const { processStringSync } = require("@budibase/string-templates")
const CouchDB = require("../db")

class QueryRunner {
  constructor(input, flags = { noRecursiveQuery: false }) {
    this.appId = input.appId
    this.datasource = input.datasource
    this.queryVerb = input.queryVerb
    this.fields = input.fields
    this.parameters = input.parameters
    this.transformer = input.transformer
    this.queryId = input.queryId
    this.noRecursiveQuery = flags.noRecursiveQuery
    this.cachedVariables = []
    // allows the response from a query to be stored throughout this
    // execution so that if it needs to be re-used for another variable
    // it can be
    this.queryResponse = {}
    this.hasRerun = false
  }

  async execute() {
    let { datasource, fields, queryVerb, transformer } = this
    // pre-query, make sure datasource variables are added to parameters
    const parameters = await this.addDatasourceVariables()
    const query = threadUtils.enrichQueryFields(fields, parameters)
    const Integration = integrations[datasource.source]
    if (!Integration) {
      throw "Integration type does not exist."
    }
    const integration = new Integration(datasource.config)

    let output = threadUtils.formatResponse(await integration[queryVerb](query))
    let rows = output,
      info = undefined,
      extra = undefined
    if (threadUtils.hasExtraData(output)) {
      rows = output.data
      info = output.info
      extra = output.extra
    }

    // transform as required
    if (transformer) {
      const runner = new ScriptRunner(transformer, { data: rows })
      rows = runner.execute()
    }

    // if the request fails we retry once, invalidating the cached value
    if (
      info &&
      info.code >= 400 &&
      this.cachedVariables.length > 0 &&
      !this.hasRerun
    ) {
      this.hasRerun = true
      // invalidate the cache value
      await threadUtils.invalidateDynamicVariables(this.cachedVariables)
      return this.execute()
    }

    // needs to an array for next step
    if (!Array.isArray(rows)) {
      rows = [rows]
    }

    // map into JSON if just raw primitive here
    if (rows.find(row => typeof row !== "object")) {
      rows = rows.map(value => ({ value }))
    }

    // get all the potential fields in the schema
    let keys = rows.flatMap(Object.keys)

    if (integration.end) {
      integration.end()
    }

    return { rows, keys, info, extra }
  }

  async runAnotherQuery(queryId, parameters) {
    const db = new CouchDB(this.appId)
    const query = await db.get(queryId)
    const datasource = await db.get(query.datasourceId)
    return new QueryRunner(
      {
        appId: this.appId,
        datasource,
        queryVerb: query.queryVerb,
        fields: query.fields,
        parameters,
        transformer: query.transformer,
      },
      { noRecursiveQuery: true }
    ).execute()
  }

  async getDynamicVariable(variable) {
    let { parameters } = this
    const queryId = variable.queryId,
      name = variable.name
    let value = await threadUtils.checkCacheForDynamicVariable(queryId, name)
    if (!value) {
      value = this.queryResponse[queryId]
        ? this.queryResponse[queryId]
        : await this.runAnotherQuery(queryId, parameters)
      // store incase this query is to be called again
      this.queryResponse[queryId] = value
      await threadUtils.storeDynamicVariable(queryId, name, value)
    } else {
      this.cachedVariables.push({ queryId, name })
    }
    return value
  }

  async addDatasourceVariables() {
    let { datasource, parameters, fields } = this
    if (!datasource || !datasource.config) {
      return parameters
    }
    const staticVars = datasource.config.staticVariables || {}
    const dynamicVars = datasource.config.dynamicVariables || []
    for (let [key, value] of Object.entries(staticVars)) {
      if (!parameters[key]) {
        parameters[key] = value
      }
    }
    if (!this.noRecursiveQuery) {
      // need to see if this uses any variables
      const stringFields = JSON.stringify(fields)
      const foundVars = dynamicVars.filter(variable => {
        // don't allow a query to use its own dynamic variable (loop)
        if (variable.queryId === this.queryId) {
          return false
        }
        // look for {{ variable }} but allow spaces between handlebars
        const regex = new RegExp(`{{[ ]*${variable.name}[ ]*}}`)
        return regex.test(stringFields)
      })
      const dynamics = foundVars.map(dynVar => this.getDynamicVariable(dynVar))
      const responses = await Promise.all(dynamics)
      for (let i = 0; i < foundVars.length; i++) {
        const variable = foundVars[i]
        parameters[variable.name] = processStringSync(variable.value, {
          data: responses[i].rows,
          info: responses[i].extra,
        })
        // make sure its known that this uses dynamic variables in case it fails
        this.hasDynamicVariables = true
      }
    }
    return parameters
  }
}

module.exports = (input, callback) => {
  const Runner = new QueryRunner(input)
  Runner.execute()
    .then(response => {
      callback(null, response)
    })
    .catch(err => {
      callback(err)
    })
}
