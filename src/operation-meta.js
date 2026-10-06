import {
  parse, print, validate, getOperationAST, getVariableValues, getNamedType,
  valueFromASTUntyped, GraphQLError,
} from 'graphql';
import { Supergraph, operationFromDocument } from '@apollo/federation-internals';
import { QueryPlanner, prettyFormatQueryPlan } from '@apollo/query-planner';

export function problem(code, message, extra = {}) {
  return new GraphQLError(message, { extensions: {
    code, retryable: false, docs: `/docs/errors/${code}.md`, ...extra,
  } });
}

// Demo identities only. No token verification: all servers bind to loopback.
export function identity(name = 'editor') {
  const scopes = {
    editor: ['products:read', 'products:write', 'orders:read'],
    admin: ['products:read', 'products:write', 'products:delete', 'orders:read'],
    viewer: ['products:read'],
  }[name];
  if (!scopes) throw problem('UNAUTHENTICATED', 'Unknown demo identity');
  return { id: name, scopes };
}

export function createInspector(supergraphSdl) {
  const supergraph = Supergraph.build(supergraphSdl);
  const schema = supergraph.apiSchema().toGraphQLJSSchema();
  const planner = new QueryPlanner(supergraph);
  const annotations = new Map();
  // Directive applications must come from composed SDL, not API introspection.
  for (const type of parse(supergraphSdl).definitions) {
    for (const field of type.fields ?? []) {
      annotations.set(`${type.name.value}.${field.name.value}`, Object.fromEntries(
        (field.directives ?? []).map(d => [d.name.value, Object.fromEntries(
          (d.arguments ?? []).map(a => [a.name.value, valueFromASTUntyped(a.value)]),
        )]),
      ));
    }
  }

  function inspect(source, rawVariables, operationName, caller) {
    const document = typeof source === 'string' ? parse(source) : source;
    const errors = validate(schema, document);
    if (errors.length) throw errors[0];
    const operation = getOperationAST(document, operationName);
    if (!operation) throw problem('BAD_USER_INPUT', 'Select exactly one operation with operationName');
    if (operation.operation === 'subscription') throw problem('BAD_USER_INPUT', 'Subscriptions are not part of this demo');
    const variablesResult = getVariableValues(schema, operation.variableDefinitions ?? [], rawVariables ?? {});
    if (variablesResult.errors) throw problem('BAD_USER_INPUT', variablesResult.errors[0].message);
    const variables = variablesResult.coerced;
    const fragments = Object.fromEntries(document.definitions.filter(d => d.kind === 'FragmentDefinition').map(d => [d.name.value, d]));
    const operationMeta = {};
    const selections = [];

    function walk(set, parent, path = []) {
      for (const node of set.selections) {
        const conditions = Object.fromEntries((node.directives ?? []).map(d => [d.name.value,
          valueFromASTUntyped(d.arguments.find(a => a.name.value === 'if')?.value, variables)]));
        if (conditions.skip === true || conditions.include === false) continue;
        if (node.kind === 'FragmentSpread') {
          const fragment = fragments[node.name.value];
          walk(fragment.selectionSet, schema.getType(fragment.typeCondition.name.value), path);
          continue;
        }
        if (node.kind === 'InlineFragment') {
          walk(node.selectionSet, node.typeCondition ? schema.getType(node.typeCondition.name.value) : parent, path);
          continue;
        }
        const coordinate = `${parent.name}.${node.name.value}`;
        const directives = annotations.get(coordinate) ?? {};
        const permissions = directives.permission?.scopes ?? [];
        const allowed = permissions.every(scope => caller.scopes.includes(scope));
        const meta = { permissions, allowed };
        if (!allowed) meta.reason = directives.permission?.reason ?? `Requires ${permissions.join(', ')}`;
        if (directives.requiresApproval) meta.approval = {
          required: true, via: 'Mutation.requestApproval',
          message: 'Approval required. Call requestApproval with this document and variables.',
        };
        if (directives.docs) meta.docs = directives.docs.url;
        if (directives.skill) meta.skill = directives.skill.name;
        operationMeta[coordinate] = meta;
        const responsePath = [...path, node.alias?.value ?? node.name.value];
        selections.push({ coordinate, path: responsePath, meta });
        const field = parent.getFields?.()[node.name.value];
        if (node.selectionSet && field) walk(node.selectionSet, getNamedType(field.type), responsePath);
      }
    }
    walk(operation.selectionSet, operation.operation === 'mutation' ? schema.getMutationType() : schema.getQueryType());
    return { document, operation, variables, operationMeta, selections, operationName: operation.name?.value };
  }

  function plan(analysis) {
    const operation = operationFromDocument(supergraph.apiSchema(), analysis.document, { operationName: analysis.operationName });
    const plan = planner.buildQueryPlan(operation);
    return { text: prettyFormatQueryPlan(plan), object: plan };
  }
  return { inspect, plan, schema };
}

export function permissionErrors(analysis) {
  return analysis.selections.filter(s => !s.meta.allowed).map(s => ({
    message: 'Unauthorized field or type', path: s.path,
    extensions: { code: 'UNAUTHORIZED_FIELD_OR_TYPE', policy: s.meta.permissions.join(', '),
      reason: s.meta.reason, retryable: false, docs: '/docs/errors/UNAUTHORIZED_FIELD_OR_TYPE.md' },
  }));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export function approvalBinding(analysis, caller) {
  return JSON.stringify([caller.id, print(analysis.document), analysis.operationName, stable(analysis.variables)]);
}
