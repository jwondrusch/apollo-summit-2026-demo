import { HeaderMap } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { permissionErrors, approvalBinding, problem } from './operation-meta.js';

const response = (result, status = 200) => ({ http: { status, headers: new HeaderMap() }, body: { kind: 'single', singleResult: result } });

export function companyModelPlugin(inspector, approvals) {
  return {
    async requestDidStart() {
      return {
        async responseForOperation({ document, request, contextValue }) {
          let analysis;
          try {
            analysis = inspector.inspect(document, request.variables, request.operationName, contextValue.caller);
          } catch (error) {
            if (!(error instanceof GraphQLError)) throw error;
            return response({ errors: [{ ...error.toJSON(), extensions: { ...error.extensions, code: error.extensions.code ?? 'BAD_USER_INPUT' } }] }, 400);
          }
          const extensions = { operationMeta: analysis.operationMeta };
          // This hook short-circuits before Gateway executes or contacts any subgraph.
          if (request.http?.headers.get('apollo-expose-query-plan') === 'dry-run') {
            return response({ extensions: { apolloQueryPlan: inspector.plan(analysis), ...extensions } });
          }
          const errors = permissionErrors(analysis);
          if (errors.length) return response({ errors, extensions });
          if (analysis.selections.some(s => s.meta.approval)) {
            const token = request.http?.headers.get('x-approval');
            if (!approvals.consume(token, approvalBinding(analysis, contextValue.caller))) {
              const error = problem('APPROVAL_REQUIRED', 'Reviewer approval required for this exact document and variables.', {
                via: 'Mutation.requestApproval',
              });
              return response({ errors: [error.toJSON()], extensions });
            }
          }
          return null;
        },
      };
    },
  };
}

// Expected bulk failures do not throw from the mutation resolver: doing so would
// null its payload. Append located GraphQL errors while retaining successful data.
export const partialSuccessPlugin = {
  async requestDidStart() {
    return {
      async willSendResponse({ response, contextValue }) {
        if (response.body.kind === 'single' && contextValue.partialErrors?.length) {
          const result = response.body.singleResult;
          result.errors = [...(result.errors ?? []), ...contextValue.partialErrors];
        }
      },
    };
  },
};
