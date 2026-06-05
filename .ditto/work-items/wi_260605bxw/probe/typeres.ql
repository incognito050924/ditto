/**
 * @id ditto/typeres
 * @kind table
 */
import java
from RefType used, int refs, string origin
where exists(TypeAccess ta | ta.getFile().getRelativePath().matches("%/BoxwoodHistoryEventHandler.java") and ta.getType() = used)
  and refs = count(TypeAccess ta | ta.getFile().getRelativePath().matches("%/BoxwoodHistoryEventHandler.java") and ta.getType() = used)
  and (if used.fromSource() then origin = "SOURCE" else origin = "library/JAR")
  and used.getPackage().getName().matches("kr.co.ecoletree%")
select origin, used.getPackage().getName() as pkg, used.getName() as type, refs order by origin, pkg
