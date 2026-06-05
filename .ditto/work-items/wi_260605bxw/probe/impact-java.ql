/**
 * @id ditto/impact-java
 * @kind table
 * Java mirror of IMPACT_QUERY_JS: resolved-callee precision + declaring-file pin
 * (decoy 배제). target = method `extractRequesterName` declared in BoxwoodHistoryEventHandler.java.
 */
import java

class TargetFile extends File {
  TargetFile() { this.getRelativePath().matches("%/BoxwoodHistoryEventHandler.java") }
}

Method targetMethod() {
  result.fromSource() and
  result.getName() = "extractRequesterName" and
  result.getFile() instanceof TargetFile
}

from string p, int ln, string kind
where
  (exists(MethodCall mc |
      mc.getMethod() = targetMethod() and mc.getCaller().fromSource() and
      p = mc.getFile().getRelativePath() and ln = mc.getLocation().getStartLine()
    ) and kind = "caller")
  or
  (exists(Method d |
      d = targetMethod() and
      p = d.getFile().getRelativePath() and ln = d.getLocation().getStartLine()
    ) and kind = "decl")
select p, ln, kind order by kind, ln
