/**
 * @id ditto/taintcap
 * @kind table
 */
import java
import semmle.code.java.dataflow.FlowSources
select
  count(RemoteFlowSource s) as remote_sources,
  count(MethodCall mc | not mc.getMethod().fromSource()) as lib_calls,
  count(MethodCall mc | not exists(mc.getMethod())) as unresolved_calls
