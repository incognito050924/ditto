/**
 * @id ditto/edge-java
 * @kind table
 * Java mirror of EDGE_QUERY_JS: cross-file source-type dependency edges from a file.
 */
import java
from TypeAccess ta, RefType used
where ta.getFile().getRelativePath().matches("%/BoxwoodHistoryEventHandler.java")
  and used = ta.getType()
  and used.fromSource()
  and used.getFile() != ta.getFile()
  and used.getPackage().getName().matches("kr.co.ecoletree%")
select used.getFile().getRelativePath() as toPath, used.getPackage().getName() as toPkg
