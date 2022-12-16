import { isAsyncIterable, Plugin } from '@envelop/core';
import { useOnResolve } from '@envelop/on-resolve';
import { GraphQLError, ResponsePath } from 'graphql';
import { google, Trace } from 'apollo-reporting-protobuf';

const ctxKey = Symbol('ApolloInlineTracePluginContextKey');

interface ApolloInlineTracePluginContext {
  startHrTime: [number, number];
  rootNode: Trace.Node;
  trace: Trace;
  nodes: Map<string, Trace.Node>;
  /**
   * graphql-js can continue to execute more fields indefinitely after
   * `execute()` resolves. That's because parallelism on a selection set
   * is implemented using `Promise.all`, and as soon as one field
   * throws an error, the combined Promise resolves, but there's no
   * "cancellation" of the rest of Promises/fields in `Promise.all`.
   */
  stopped: boolean;
}

export interface ApolloInlineTracePluginOptions<PluginContext extends Record<string, any> = {}> {
  /**
   * Decide whether the operation should be traced.
   *
   * When dealing with HTTP requests, `apollo-federation-include-trace` header must be set to `ftv1`.
   */
  shouldTrace(ctx: PluginContext): boolean;
  /**
   * Format errors before being sent for tracing. Beware that only the error
   * `message` and `extensions` can be changed.
   *
   * Return `null` to skip reporting error.
   */
  rewriteError?: (err: GraphQLError) => GraphQLError | null;
}

/**
 * Produces Apollo's base64 trace protocol containing timing, resolution and
 * errors information.
 *
 * The output is placed in `extensions.ftv1` of the GraphQL result.
 *
 * The Apollo Gateway utilizes this data to construct the full trace and submit
 * it to Apollo's usage reporting ingress.
 */
export function useApolloInlineTrace<PluginContext extends Record<string, any> = {}>({
  shouldTrace,
  rewriteError,
}: ApolloInlineTracePluginOptions<PluginContext>): Plugin<
  PluginContext & { [ctxKey]: ApolloInlineTracePluginContext }
> {
  return {
    onEnveloped({ context, extendContext }) {
      if (!context) {
        throw new Error("Context must be set for Apollo's inline tracing plugin");
      }

      if (shouldTrace(context)) {
        const startHrTime = process.hrtime();
        const rootNode = new Trace.Node();
        extendContext({
          ...context,
          [ctxKey]: {
            startHrTime,
            rootNode,
            trace: new Trace({
              root: rootNode,
              fieldExecutionWeight: 1, // Why 1? See: https://github.com/apollographql/apollo-server/blob/9389da785567a56e989430962564afc71e93bd7f/packages/apollo-server-core/src/plugin/traceTreeBuilder.ts#L16-L23
              startTime: nowTimestamp(),
            }),
            nodes: new Map([[responsePathToString(), rootNode]]),
            stopped: false,
          },
        });
      }
    },
    onPluginInit({ addPlugin }) {
      addPlugin(
        useOnResolve(({ context, info }) => {
          const ctx = context[ctxKey];
          if (!ctx) return;

          // result was already shipped (see ApolloInlineTracePluginContext.stopped)
          if (ctx.stopped) {
            return () => {
              // noop
            };
          }

          const node = newTraceNode(ctx, info.path);
          node.type = info.returnType.toString();
          node.parentType = info.parentType.toString();
          node.startTime = hrTimeToDurationInNanos(process.hrtime(ctx.startHrTime));
          if (typeof info.path.key === 'string' && info.path.key !== info.fieldName) {
            // field was aliased, send the original field name too
            node.originalFieldName = info.fieldName;
          }

          return () => {
            node.endTime = hrTimeToDurationInNanos(process.hrtime(ctx.startHrTime));
          };
        })
      );
    },
    onPerform({ context }) {
      return {
        onPerformDone({ result }) {
          const ctx = context[ctxKey];
          if (!ctx) return;

          // TODO: should handle streaming results? how?
          if (isAsyncIterable(result)) return;

          if (result.extensions?.ftv1 !== undefined) {
            throw new Error('The `ftv1` extension is already present');
          }

          // onResultProcess will be called only once since we disallow async iterables
          if (ctx.stopped) throw new Error('Trace stopped multiple times');

          if (result.errors) {
            handleErrors(ctx, result.errors, rewriteError);
          }

          ctx.stopped = true;
          ctx.trace.durationNs = hrTimeToDurationInNanos(process.hrtime(ctx.startHrTime));
          ctx.trace.endTime = nowTimestamp();

          const encodedUint8Array = Trace.encode(ctx.trace).finish();
          const base64 = btoa(String.fromCharCode(...encodedUint8Array));

          result.extensions = {
            ...result.extensions,
            ftv1: base64,
          };
        },
      };
    },
  };
}

/**
 * Converts an hrtime array (as returned from process.hrtime) to nanoseconds.
 *
 * The entire point of the hrtime data structure is that the JavaScript Number
 * type can't represent all int64 values without loss of precision.
 *
 * Reference: https://github.com/apollographql/apollo-server/blob/9389da785567a56e989430962564afc71e93bd7f/packages/apollo-server-core/src/plugin/traceTreeBuilder.ts#L269-L285
 */
function hrTimeToDurationInNanos(hrtime: [number, number]) {
  return hrtime[0] * 1e9 + hrtime[1];
}

/**
 * Current time from Date.now() as a google.protobuf.Timestamp.
 *
 * Reference: https://github.com/apollographql/apollo-server/blob/9389da785567a56e989430962564afc71e93bd7f/packages/apollo-server-core/src/plugin/traceTreeBuilder.ts#L315-L323
 */
function nowTimestamp(): google.protobuf.Timestamp {
  const totalMillis = Date.now();
  const millis = totalMillis % 1000;
  return new google.protobuf.Timestamp({
    seconds: (totalMillis - millis) / 1000,
    nanos: millis * 1e6,
  });
}

/**
 * Convert from the linked-list ResponsePath format to a dot-joined
 * string. Includes the full path (field names and array indices).
 *
 * Reference: https://github.com/apollographql/apollo-server/blob/9389da785567a56e989430962564afc71e93bd7f/packages/apollo-server-core/src/plugin/traceTreeBuilder.ts#L287-L303
 */
function responsePathToString(path?: ResponsePath): string {
  if (path === undefined) {
    return '';
  }

  // `responsePathAsArray` from `graphql-js/execution` created new arrays unnecessarily
  let res = String(path.key);

  while ((path = path.prev) !== undefined) {
    res = `${path.key}.${res}`;
  }

  return res;
}

function ensureParentTraceNode(ctx: ApolloInlineTracePluginContext, path: ResponsePath): Trace.Node {
  const parentNode = ctx.nodes.get(responsePathToString(path.prev));
  if (parentNode) return parentNode;
  // path.prev isn't undefined because we set up the root path in ctx.nodes
  return newTraceNode(ctx, path.prev!);
}

function newTraceNode(ctx: ApolloInlineTracePluginContext, path: ResponsePath) {
  const node = new Trace.Node();
  const id = path.key;
  if (typeof id === 'number') {
    node.index = id;
  } else {
    node.responseName = id;
  }
  ctx.nodes.set(responsePathToString(path), node);
  const parentNode = ensureParentTraceNode(ctx, path);
  parentNode.child.push(node);
  return node;
}

function handleErrors(
  ctx: ApolloInlineTracePluginContext,
  errors: readonly GraphQLError[],
  rewriteError: ApolloInlineTracePluginOptions['rewriteError']
) {
  if (ctx.stopped) {
    throw new Error('Handling errors after tracing was stopped');
  }

  for (const err of errors) {
    /**
     * This is an error from a federated service. We will already be reporting
     * it in the nested Trace in the query plan.
     *
     * Reference: https://github.com/apollographql/apollo-server/blob/9389da785567a56e989430962564afc71e93bd7f/packages/apollo-server-core/src/plugin/traceTreeBuilder.ts#L133-L141
     */
    if (err.extensions?.serviceName) {
      continue;
    }

    let errToReport = err;

    // errors can be rewritten through `rewriteError`
    if (rewriteError) {
      // clone error to avoid users mutating the original one
      const clonedErr = Object.assign(Object.create(Object.getPrototypeOf(err)), err);
      const rewrittenError = rewriteError(clonedErr);
      if (!rewrittenError) {
        // return nullish to skip reporting
        continue;
      }
      errToReport = rewrittenError;
    }

    // only message and extensions can be rewritten
    errToReport = new GraphQLError(errToReport.message, {
      extensions: errToReport.extensions || err.extensions,
      nodes: err.nodes,
      source: err.source,
      positions: err.positions,
      path: err.path,
      originalError: err.originalError,
    });

    // put errors on the root node by default
    let node = ctx.rootNode;

    if (Array.isArray(errToReport.path)) {
      const specificNode = ctx.nodes.get(errToReport.path.join('.'));
      if (specificNode) {
        node = specificNode;
      } else {
        throw new Error(`Could not find node with path ${errToReport.path.join('.')}`);
      }
    }

    node.error.push(
      new Trace.Error({
        message: errToReport.message,
        location: (errToReport.locations || []).map(({ line, column }) => new Trace.Location({ line, column })),
        json: JSON.stringify(errToReport),
      })
    );
  }
}